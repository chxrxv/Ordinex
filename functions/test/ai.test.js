'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../ai');

test('validateInput rejects missing, empty, oversized and non-string input', () => {
  for (const bad of [null, {}, { prompt: '' }, { prompt: '   ' }, { prompt: 5 }, { prompt: 'x'.repeat(ai.LIMITS.prompt + 1) }, { prompt: 'x', systemInstruction: 'y'.repeat(ai.LIMITS.system + 1) }, { prompt: 'x', systemInstruction: {} }]) {
    assert.throws(() => ai.validateInput(bad), (e) => e instanceof ai.AiError && e.code === 'invalid-argument');
  }
  assert.deepEqual(ai.validateInput({ prompt: 'hi', jsonOutput: true }), { prompt: 'hi', systemInstruction: '', jsonOutput: true });
  assert.equal(ai.validateInput({ prompt: 'hi', jsonOutput: 'yes' }).jsonOutput, false);
});

test('daily quota counts up and then refuses', () => {
  assert.equal(ai.nextUsage(undefined), 1);
  assert.equal(ai.nextUsage(ai.LIMITS.daily - 1), ai.LIMITS.daily);
  assert.throws(() => ai.nextUsage(ai.LIMITS.daily), (e) => e.code === 'resource-exhausted');
  assert.equal(ai.dayKey('u1', new Date('2026-10-29T23:59:59Z')), 'u1_20261029');
});

test('request body: JSON mode and system instruction are set only when asked', () => {
  const plain = ai.buildRequest({ prompt: 'p', systemInstruction: '', jsonOutput: false });
  assert.equal(plain.systemInstruction, undefined);
  assert.equal(plain.generationConfig.responseMimeType, undefined);
  const json = ai.buildRequest({ prompt: 'p', systemInstruction: 's', jsonOutput: true });
  assert.equal(json.generationConfig.responseMimeType, 'application/json');
  assert.equal(json.systemInstruction.parts[0].text, 's');
});

test('extractText returns text and refuses empty/blocked answers', () => {
  assert.equal(ai.extractText({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab');
  assert.throws(() => ai.extractText({ candidates: [] }), /no answer/);
  assert.throws(() => ai.extractText({ promptFeedback: { blockReason: 'SAFETY' } }), /SAFETY/);
});

test('callGemini sends the key in a header (never the URL) and maps provider errors', async () => {
  let seen;
  const ok = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }) }; };
  assert.equal(await ai.callGemini('SECRETKEY', { prompt: 'p', systemInstruction: '', jsonOutput: false }, ok), 'hello');
  assert.ok(!seen.url.includes('SECRETKEY'));
  assert.equal(seen.init.headers['x-goog-api-key'], 'SECRETKEY');
  const status = (s) => async () => ({ ok: s < 400, status: s, json: async () => ({}) });
  await assert.rejects(ai.callGemini('k', { prompt: 'p' }, status(429)), (e) => e.code === 'resource-exhausted');
  await assert.rejects(ai.callGemini('k', { prompt: 'p' }, status(500)), (e) => e.code === 'unavailable' && !/k/.test('') );
});
