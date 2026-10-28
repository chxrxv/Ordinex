'use strict';

const STATUSES = ['Compliant', 'Partially compliant', 'Non-compliant', 'Insufficient evidence'];

/** JSON Schema handed to Ollama (constrained decoding) AND re-checked below. */
const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: STATUSES },
    reasoning: { type: 'string' },
    // The model cites a chunk and a sentence NUMBER; the application copies the quote from the real chunk text.
    evidence: { type: 'array', items: { type: 'object', properties: { chunkId: { type: 'string' }, sentence: { type: 'integer' } }, required: ['chunkId', 'sentence'] } },
    missing: { type: 'string' },
  },
  required: ['status', 'reasoning', 'evidence'],
};

const REMEDIATION_SCHEMA = {
  type: 'object',
  properties: { action: { type: 'string' }, whyItMatters: { type: 'string' }, remainingUncertainty: { type: 'string' } },
  required: ['action', 'whyItMatters'],
};

// Whitespace-, case- and punctuation-insensitive: still requires the same words in the same order.
const ws = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function parseJson(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'empty' };
  const t = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return { ok: true, value: JSON.parse(t) }; } catch { /* try to find an object */ }
  const m = /\{[\s\S]*\}/.exec(t);
  if (m) { try { return { ok: true, value: JSON.parse(m[0]) }; } catch { /* fallthrough */ } }
  return { ok: false, error: 'not-json' };
}

/**
 * Application-side authority over model output.
 * - schema/enum check
 * - every cited chunkId must be one we actually supplied
 * - every quote must appear verbatim (whitespace-insensitive) in that chunk
 * - a Compliant / Partially / Non-compliant verdict with no verified quote is
 *   downgraded to Insufficient evidence (the model cannot self-certify)
 * Returns { finding, flags[] }.
 */
/** Shared by the prompt builder and the validator so sentence numbers always align. */
function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
}

function validateFinding(raw, suppliedChunks) {
  const flags = [];
  const parsed = parseJson(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error, flags: ['unparseable-model-output'] };
  const v = parsed.value;
  if (!v || typeof v !== 'object' || !STATUSES.includes(v.status) || typeof v.reasoning !== 'string') {
    return { ok: false, error: 'schema', flags: ['schema-violation'] };
  }
  // The model sees short aliases (C1, C2…); full ids are accepted too.
  const byId = new Map();
  suppliedChunks.forEach((c) => { byId.set(c.id, c); if (c.alias) byId.set(String(c.alias).toLowerCase(), c); });
  const verified = [];
  for (const e of Array.isArray(v.evidence) ? v.evidence : []) {
    const chunk = byId.get(e?.chunkId) || byId.get(String(e?.chunkId || '').toLowerCase());
    if (!chunk) { flags.push(`fabricated-chunk-reference:${String(e?.chunkId).slice(0, 40)}`); continue; }
    if (e && e.sentence !== undefined && e.sentence !== null) {
      const n = Number(e.sentence);
      const sent = Number.isInteger(n) ? splitSentences(chunk.text)[n - 1] : undefined;
      if (!sent || sent.length < 8) { flags.push(`sentence-out-of-range:${chunk.id}`); continue; }
      if (looksInjected(sent)) { flags.push(`cited-instruction-like-sentence:${chunk.id}`); continue; }
      verified.push({ chunkId: chunk.id, docId: chunk.docId, docName: chunk.docName, ref: chunk.ref, quote: sent.slice(0, 400), citedSentence: n });
      continue;
    }
    const q = ws(e.quote);
    if (q.length < 8 || !ws(chunk.text).includes(q)) { flags.push(`quote-not-in-chunk:${chunk.id}`); continue; }
    verified.push({ chunkId: chunk.id, docId: chunk.docId, docName: chunk.docName, ref: chunk.ref, quote: String(e.quote).trim().slice(0, 400) });
  }
  let status = v.status;
  let reasoning = String(v.reasoning).trim().slice(0, 800);
  if (status !== 'Insufficient evidence' && verified.length === 0) {
    flags.push('verdict-without-verified-evidence');
    reasoning = `[Model said "${status}" but cited no verifiable quote; downgraded.] ${reasoning}`.slice(0, 900);
    status = 'Insufficient evidence';
  }
  return { ok: true, finding: { status, modelStatus: v.status, reasoning, evidence: verified, missing: String(v.missing || '').slice(0, 400) }, flags };
}

function validateRemediation(raw) {
  const p = parseJson(raw);
  if (!p.ok || typeof p.value?.action !== 'string' || !p.value.action.trim()) return { ok: false };
  return { ok: true, value: { action: p.value.action.trim().slice(0, 600), whyItMatters: String(p.value.whyItMatters || '').trim().slice(0, 400), remainingUncertainty: String(p.value.remainingUncertainty || '').trim().slice(0, 300) } };
}

const INJECTION_RE = /(ignore (all |any )?(previous|prior|above) (instructions|rules)|disregard (the )?(system|above)|you are now|new instructions:|reveal (the |your )?system prompt|mark (this|it|every \w+) (as|obligation as) compliant|mark every obligation|(system|assistant) instruction)/i;

/** Prompt-injection hygiene: instruction-like sentences are removed (never
 * obeyed, never shown to the model), and role markers / our own delimiters
 * are stripped from untrusted text. */
function sanitizeUntrusted(text) {
  const cleaned = String(text || '')
    .split(/(?<=[.!?])\s+|\n/)
    .map((s) => (INJECTION_RE.test(s) ? '[instruction-like text removed]' : s))
    .join('\n');
  return cleaned
    .replace(/<<<|>>>/g, '')
    .replace(/<\/?(system|assistant|user|think)>/gi, '')
    .replace(/\[\/?INST\]/gi, '')
    .slice(0, 4000);
}
const looksInjected = (t) => INJECTION_RE.test(String(t || ''));

module.exports = { splitSentences, FINDING_SCHEMA, REMEDIATION_SCHEMA, STATUSES, validateFinding, validateRemediation, parseJson, sanitizeUntrusted, looksInjected };
