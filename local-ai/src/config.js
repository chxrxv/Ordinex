'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Minimal .env loader (no dependency). Real environment variables win.
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* no .env is fine */ }
}
loadEnv(path.join(ROOT, '.env'));

const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

const config = {
  ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  model: process.env.OLLAMA_MODEL || 'qwen3:4b',
  fallbackModel: process.env.OLLAMA_FALLBACK_MODEL || 'llama3.2:1b',
  numCtx: num(process.env.OLLAMA_NUM_CTX, 8192),
  timeoutMs: num(process.env.OLLAMA_TIMEOUT_MS, 180000),
  temperature: num(process.env.OLLAMA_TEMPERATURE, 0.1),
  port: num(process.env.PORT, 8787),
  host: '127.0.0.1',
  // Extra browser origins allowed to call this backend (e.g. the hosted site, https://ordinex-862ba.web.app).
  // EMPTY BY DEFAULT: only pages served from loopback may use the API. Opting in lets that origin (and any
  // script running on it) read your local assessments, so add only origins you trust.
  allowedOrigins: String(process.env.ORDINEX_ALLOWED_ORIGINS || '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter((x) => /^https?:\/\/[^\s/]+$/.test(x)),
  maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 25) * 1024 * 1024,
  dataDir: process.env.ORDINEX_DATA_DIR ? path.resolve(process.env.ORDINEX_DATA_DIR) : path.join(ROOT, 'data'),
  publicDir: path.join(ROOT, '..', 'public'),
  regulationsFile: path.join(ROOT, 'regdata', 'regulations.json'),
};
module.exports = config;
