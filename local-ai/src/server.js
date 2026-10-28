'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const ollama = require('./ollama');
const { ingest } = require('./documents');
const R = require('./retrieval');
const { runAssessment } = require('./pipeline');
const report = require('./report');

const docs = new Map();      // docId -> ingested doc (text stays in memory + data/docs)
const jobs = new Map();      // jobId -> { status, progress, assessmentId, error, ctrl }
fs.mkdirSync(path.join(config.dataDir, 'assessments'), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'docs'), { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const ID_RE = /^[a-z]+-[0-9a-f]{10}$/;

function send(res, code, body, type = 'application/json', headers = {}) {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const err = (res, code, message, extra = {}) => send(res, code, { error: message, ...extra });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0, over = false;
    const tooBig = () => reject(Object.assign(new Error('Body too large'), { code: 413 }));
    // Reject early on Content-Length; otherwise stop buffering but keep draining so the 413 can be delivered.
    if (Number(req.headers['content-length']) > limit) { req.resume(); return tooBig(); }
    req.on('data', (c) => { n += c.length; if (over) return; if (n > limit) { over = true; parts.length = 0; tooBig(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
const readJson = async (req, limit = 1 << 20) => { try { return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}'); } catch (e) { throw Object.assign(new Error(e.code === 413 ? 'Body too large' : 'Invalid JSON'), { code: e.code === 413 ? 413 : 400 }); } };

function loadAssessment(id) {
  if (!ID_RE.test(id)) return null;           // no path traversal: ids are generated, pattern-checked
  const f = path.join(config.dataDir, 'assessments', `${id}.json`);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { corrupt: true }; }
}

async function route(req, res) {
  // DNS-rebinding guard: only loopback Host headers are served.
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || '')) return err(res, 403, 'Forbidden host');
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const origin = req.headers.origin;
  const loopbackOrigin = origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  const originAllowed = !origin || loopbackOrigin || config.allowedOrigins.includes(origin);
  // A browser page from any other origin is refused outright (not merely unable to read the reply).
  if (p.startsWith('/api/') && !originAllowed) return err(res, 403, 'Origin not allowed. To let a hosted page use this backend, set ORDINEX_ALLOWED_ORIGINS (see local-ai/README.md).');
  if (origin && originAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    // Chrome's Private Network Access preflight for public pages calling loopback.
    if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (p === '/api/health') {
    const h = await ollama.health();
    const { dataset, provisions } = R.loadRegulations();
    return send(res, 200, { backend: 'ok', ai: h, aiAvailable: h.reachable && h.modelInstalled, dataset: { ...dataset, provisionCount: provisions.size }, ocrAvailable: false });
  }
  if (p === '/api/regulations') {
    const { dataset, regs } = R.loadRegulations();
    return send(res, 200, { dataset, regulations: [...regs.values()].map((r) => ({ id: r.id, name: r.name, short: r.short, jurisdictions: r.jurisdictions, sourceUrl: r.sourceUrl, provisions: r.provisions.map(({ evidenceTerms, ...rest }) => rest) })) });
  }
  if (p === '/api/regulations/search') {
    const jur = (url.searchParams.get('jurisdictions') || '').split(',').filter(Boolean);
    return send(res, 200, { results: R.searchProvisions(url.searchParams.get('q') || '', { jurisdictions: jur }) });
  }
  if (p === '/api/documents' && req.method === 'POST') {
    let buf;
    try { buf = await readBody(req, config.maxUploadBytes); } catch (e) { return err(res, 413, `File exceeds ${config.maxUploadBytes / 1048576} MB limit.`); }
    const d = await ingest({ filename: (() => { try { return decodeURIComponent(req.headers['x-filename'] || 'document'); } catch { return 'document'; } })(), buffer: buf, maxBytes: config.maxUploadBytes });
    docs.set(d.id, d);
    const { chunks, ...summary } = d;
    return send(res, d.status === 'parsed' ? 200 : 422, { ...summary, chunkCount: chunks.length });
  }
  if (p === '/api/analyze' && req.method === 'POST') {
    const body = await readJson(req);
    const selected = (body.documentIds || []).map((i) => docs.get(i)).filter(Boolean);
    if (!selected.some((d) => d.status === 'parsed')) return err(res, 400, 'No parsed documents selected. Upload at least one readable PDF/DOCX/TXT.');
    const h = await ollama.health();
    if (!h.reachable) return err(res, 503, `Local AI unavailable: Ollama is not reachable at ${config.ollamaUrl}. Start Ollama (see local-ai/README.md).`, { code: 'unreachable' });
    if (!h.modelInstalled) return err(res, 503, `Local AI unavailable: model "${config.model}" is not installed. Run: ollama pull ${config.model}`, { code: 'model-missing' });
    if ([...jobs.values()].some((j) => j.status === 'running')) return err(res, 409, 'An analysis is already running. Wait for it to finish or cancel it.', { code: 'busy' });
    const jobId = 'job-' + crypto.randomBytes(5).toString('hex');
    const ctrl = new AbortController();
    const job = { id: jobId, status: 'running', progress: { stage: 'starting', done: 0, total: 0 }, ctrl };
    jobs.set(jobId, job);
    runAssessment({ profile: body.profile || {}, documents: selected, signal: ctrl.signal, onProgress: (pr) => { job.progress = pr; } })
      .then((snap) => { fs.writeFileSync(path.join(config.dataDir, 'assessments', `${snap.id}.json`), JSON.stringify(snap, null, 2)); job.status = 'done'; job.assessmentId = snap.id; })
      .catch((e) => { job.status = e.code === 'cancelled' ? 'cancelled' : 'failed'; job.error = { message: e.message, code: e.code || 'error' }; });
    return send(res, 202, { jobId });
  }
  let m;
  if ((m = /^\/api\/jobs\/([\w-]+)(\/cancel)?$/.exec(p))) {
    const job = jobs.get(m[1]);
    if (!job) return err(res, 404, 'Unknown job.');
    if (m[2] && req.method === 'POST') { job.ctrl.abort(); return send(res, 200, { cancelling: true }); }
    const { ctrl, ...pub } = job;
    return send(res, 200, pub);
  }
  if ((m = /^\/api\/assessments\/([\w-]+)(?:\/report)?$/.exec(p))) {
    const s = loadAssessment(m[1]);
    if (!s) return err(res, 404, 'Assessment not found.');
    if (s.corrupt) return err(res, 422, 'Saved assessment file is unreadable.');
    if (p.endsWith('/report')) {
      const fmt = url.searchParams.get('format') || 'md';
      try {
        const dl = (ext) => (url.searchParams.get('download') ? { 'Content-Disposition': `attachment; filename="ordinex-${s.id}.${ext}"` } : {});
        // The HTML report only contains escaped text, but a CSP is applied as defence in depth.
        if (fmt === 'html') return send(res, 200, report.toHtml(s), 'text/html; charset=utf-8', { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", ...dl('html') });
        if (fmt === 'json') return send(res, 200, s, 'application/json', dl('json'));
        if (fmt === 'md') return send(res, 200, report.toMarkdown(s), 'text/markdown; charset=utf-8', dl('md'));
        return err(res, 400, 'Unsupported report format. Use md, html or json (PDF/DOCX export is not implemented).');
      } catch (e) { return err(res, 409, e.message); }
    }
    return send(res, 200, s);
  }
  if (p === '/api/assessments') {
    const dir = path.join(config.dataDir, 'assessments');
    const out = [];
    for (const f of fs.readdirSync(dir).filter((x) => /^asm-[0-9a-f]{10}\.json$/.test(x))) {
      try { const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); out.push({ id: s.id, createdAt: s.createdAt, riskSummary: s.riskSummary, counts: s.counts, model: s.model.name }); } catch { /* malformed saved file: skipped, not fatal */ }
    }
    return send(res, 200, out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  }
  // Generic local generation for the existing UI (chat, summaries). Local model only.
  if (p === '/api/ai/generate' && req.method === 'POST') {
    const b = await readJson(req, 4 << 20);
    if (typeof b.prompt !== 'string' || !b.prompt.trim()) return err(res, 400, 'prompt is required');
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    try {
      const out = await ollama.chat({ system: b.systemInstruction, user: b.prompt.slice(0, 24000), schema: b.json ? { type: 'object' } : undefined, maxTokens: Math.min(Number(b.maxTokens) || 900, 2048), signal: ctrl.signal });
      return send(res, 200, { text: out.content, model: out.model, stats: out.stats });
    } catch (e) { return err(res, e.code === 'cancelled' ? 499 : 503, e.message, { code: e.code }); }
  }

  // Static UI (same origin as the API).
  if (req.method === 'GET' && !p.startsWith('/api/')) {
    let rel;
    try { rel = p === '/' ? '/ordinex.html' : decodeURIComponent(p); } catch { return err(res, 400, 'Bad path encoding'); }
    if (rel.includes('\0')) return err(res, 400, 'Bad path');
    const full = path.resolve(config.publicDir, '.' + rel);
    if (!full.startsWith(path.resolve(config.publicDir) + path.sep)) return err(res, 403, 'Forbidden');
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
  }
  return err(res, 404, 'Not found');
}

function createServer() {
  return http.createServer((req, res) => route(req, res).catch((e) => {
    console.error('request error:', req.method, req.url, e.message);   // never log bodies/document text
    if (!res.headersSent) err(res, e.code === 413 ? 413 : e.code === 400 ? 400 : 500, e.code === 413 || e.code === 400 ? e.message : 'Internal error');
  }));
}

if (require.main === module) {
  const srv = createServer();
  srv.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Stop the other process or run with PORT=<other>.` : `Server error: ${e.message}`);
    process.exit(1);
  });
  srv.listen(config.port, config.host, async () => {
    console.log(`Ordinex local backend: http://127.0.0.1:${config.port}  (UI at /, API at /api)`);
    const h = await ollama.health();
    console.log(h.reachable ? `Ollama ${h.ollamaVersion} reachable; model ${config.model} ${h.modelInstalled ? 'installed' : 'NOT installed (ollama pull ' + config.model + ')'}` : 'Ollama NOT reachable — AI analysis disabled until it is started. The app still runs.');
  });
}
module.exports = { createServer };
