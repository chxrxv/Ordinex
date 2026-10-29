'use strict';
// Pure helpers for the hosted AI proxy. No Firebase imports, so they can be unit-tested without emulators.

const MODEL = 'gemini-flash-lite-latest';
const LIMITS = { prompt: 60000, system: 8000, daily: 60, outTokens: 2048 };

class AiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function validateInput(data) {
  const d = data && typeof data === 'object' ? data : {};
  if (typeof d.prompt !== 'string' || !d.prompt.trim()) throw new AiError('invalid-argument', 'A prompt is required.');
  if (d.prompt.length > LIMITS.prompt) throw new AiError('invalid-argument', `The prompt is too long (limit ${LIMITS.prompt} characters).`);
  const system = d.systemInstruction == null ? '' : d.systemInstruction;
  if (typeof system !== 'string' || system.length > LIMITS.system) throw new AiError('invalid-argument', 'Invalid system instruction.');
  return { prompt: d.prompt, systemInstruction: system, jsonOutput: d.jsonOutput === true };
}

const dayKey = (uid, now = new Date()) => `${uid}_${now.toISOString().slice(0, 10).replace(/-/g, '')}`;

/** Pure quota decision: returns the new count, or throws when today's allowance is used up. */
function nextUsage(current) {
  const n = Number.isInteger(current) ? current : 0;
  if (n >= LIMITS.daily) throw new AiError('resource-exhausted', `Daily AI limit reached (${LIMITS.daily} requests per user). Try again tomorrow.`);
  return n + 1;
}

function buildRequest({ prompt, systemInstruction, jsonOutput }) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: LIMITS.outTokens, ...(jsonOutput ? { responseMimeType: 'application/json' } : {}) },
  };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  return body;
}

function extractText(resp) {
  const c = resp && resp.candidates && resp.candidates[0];
  const text = c && c.content && Array.isArray(c.content.parts) ? c.content.parts.map((p) => p.text || '').join('') : '';
  if (!text.trim()) {
    const why = (resp && resp.promptFeedback && resp.promptFeedback.blockReason) || (c && c.finishReason) || 'empty answer';
    throw new AiError('failed-precondition', `The model returned no answer (${String(why).slice(0, 40)}).`);
  }
  return text;
}

/** Calls Gemini. The key travels in a header, never in a URL, and is never logged or returned. */
async function callGemini(apiKey, input, fetchImpl = fetch) {
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(buildRequest(input)),
  });
  if (res.status === 429) throw new AiError('resource-exhausted', 'The AI provider is rate-limiting requests. Try again shortly.');
  if (!res.ok) throw new AiError('unavailable', `The AI provider returned an error (${res.status}).`);
  return extractText(await res.json());
}

module.exports = { MODEL, LIMITS, AiError, validateInput, dayKey, nextUsage, buildRequest, extractText, callGemini };
