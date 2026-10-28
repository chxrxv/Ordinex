'use strict';
const config = require('./config');

class AIUnavailableError extends Error {
  constructor(code, message, detail) { super(message); this.name = 'AIUnavailableError'; this.code = code; this.detail = detail; }
}

async function http(pathname, { method = 'GET', body, timeoutMs = 10000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  try {
    const res = await fetch(config.ollamaUrl + pathname, {
      method, signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    // Read the whole body BEFORE the timer is cleared, so a stalled generation also times out.
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, json: () => JSON.parse(text) };
  } catch (e) {
    if (signal?.aborted) throw new AIUnavailableError('cancelled', 'The request was cancelled.');
    if (ctrl.signal.aborted) throw new AIUnavailableError('timeout', `The local model did not answer within ${Math.round(timeoutMs / 1000)}s. Try a smaller model or raise OLLAMA_TIMEOUT_MS.`);
    throw new AIUnavailableError('unreachable', `Cannot reach Ollama at ${config.ollamaUrl}. Install/start Ollama (see local-ai/README.md).`, String(e.cause?.code || e.message));
  } finally { clearTimeout(timer); }
}

/** Reports whether Ollama is up, which models are installed, and whether the
 * configured model is currently resident on GPU (from /api/ps). */
async function health() {
  const out = { reachable: false, url: config.ollamaUrl, model: config.model, modelInstalled: false, installedModels: [], loaded: null };
  try {
    const v = await http('/api/version');
    out.reachable = v.ok;
    out.ollamaVersion = v.json().version;
    const tags = (await http('/api/tags')).json();
    out.installedModels = (tags.models || []).map((m) => m.name);
    out.modelInstalled = out.installedModels.some((n) => n === config.model || n === `${config.model}:latest`);
    const ps = (await http('/api/ps')).json();
    const m = (ps.models || []).find((x) => x.name === config.model);
    if (m) out.loaded = { sizeBytes: m.size, vramBytes: m.size_vram, processor: m.size_vram >= m.size ? 'GPU' : m.size_vram > 0 ? 'GPU+CPU split' : 'CPU' };
  } catch (e) { out.error = e.message; out.code = e.code; }
  return out;
}

/** Real local inference through Ollama /api/chat. `schema` (JSON Schema) makes
 * Ollama constrain output to valid JSON of that shape. Never contacts any
 * other host. Throws AIUnavailableError with a user-facing message. */
async function chat({ system, user, schema, model = config.model, maxTokens = 700, signal, timeoutMs = config.timeoutMs }) {
  const res = await http('/api/chat', {
    method: 'POST', signal, timeoutMs,
    body: {
      model, stream: false, think: false,
      ...(schema ? { format: schema } : {}),
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }],
      options: { temperature: config.temperature, num_ctx: config.numCtx, num_predict: maxTokens },
    },
  });
  if (!res.ok) {
    const t = res.text;
    if (res.status === 404) throw new AIUnavailableError('model-missing', `Model "${model}" is not installed. Run: ollama pull ${model}`, t);
    if (/memory|cuda|alloc/i.test(t)) throw new AIUnavailableError('out-of-memory', `Not enough memory to load "${model}". Use a smaller model or lower OLLAMA_NUM_CTX.`, t);
    throw new AIUnavailableError('ollama-error', `Ollama returned HTTP ${res.status}.`, t.slice(0, 300));
  }
  const j = res.json();
  const content = String(j.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return {
    content, model: j.model || model,
    stats: { totalMs: Math.round((j.total_duration || 0) / 1e6), loadMs: Math.round((j.load_duration || 0) / 1e6), promptTokens: j.prompt_eval_count, outputTokens: j.eval_count },
  };
}

module.exports = { health, chat, AIUnavailableError };
