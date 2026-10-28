'use strict';
// Test infrastructure. The FAKE Ollama below is a MOCK used only by the *.fast / *.api specs to
// exercise UI and failure paths deterministically. The real-model test (e2e.spec.js) never uses it.
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'server.js');
const FIX = path.join(__dirname, '..', 'fixtures');
// The fake "executable" used by unsupported-type tests is generated here rather than committed (avoids AV/scanner noise).
if (!fs.existsSync(path.join(FIX, 'tool.exe'))) fs.writeFileSync(path.join(FIX, 'tool.exe'), Buffer.from('MZ\x90\x00not-a-real-program'));
const fixture = (n) => path.join(FIX, n);

/** Mock Ollama. mode: ok | slow | badjson | http500 | oom | nomodel */
function startFakeOllama(port) {
  const state = { mode: 'ok', delayMs: 0, chatCalls: 0 };
  const srv = http.createServer((req, res) => {
    const json = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/version') return json(200, { version: 'fake-0' });
    if (req.url === '/api/tags') return json(200, { models: state.mode === 'nomodel' ? [] : [{ name: 'qwen3:4b' }] });
    if (req.url === '/api/ps') return json(200, { models: [{ name: 'qwen3:4b', size: 100, size_vram: 100 }] });
    if (req.url === '/api/chat') {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', async () => {
        state.chatCalls++;
        const body = JSON.parse(b || '{}');
        const user = body.messages?.at(-1)?.content || '';
        if (state.mode === 'slow') await new Promise((r) => setTimeout(r, state.delayMs || 2500));
        if (state.mode === 'http500') return json(500, { error: 'boom' });
        if (state.mode === 'oom') return json(500, { error: 'cuda out of memory' });
        const isFinding = !!body.format?.properties?.status;
        let content;
        if (state.mode === 'badjson') content = 'I am sorry, here is some prose and no JSON.';
        else if (isFinding) {
          // Mock model: cites the first numbered sentence of the first supplied chunk.
          const m = /\[(C\d+)\.1\] /.exec(user);
          content = JSON.stringify({ status: 'Compliant', reasoning: 'Mock model: documented control found.', evidence: m ? [{ chunkId: m[1], sentence: 1 }] : [] });
        } else content = JSON.stringify({ action: 'Mock remediation action.', whyItMatters: 'Mock rationale.' });
        json(200, { model: 'qwen3:4b', message: { content }, total_duration: 1e6, prompt_eval_count: 1, eval_count: 1 });
      });
      return;
    }
    json(404, {});
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ state, close: () => new Promise((r) => srv.close(r)) })));
}

async function waitHealthy(port, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`backend on ${port} did not become healthy`);
}

/** Starts the real backend with an isolated temp data dir (never touches local-ai/data). */
async function startBackend({ port, ollamaUrl, dataDir, model = 'qwen3:4b', env = {} }) {
  dataDir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ordinex-ui-'));
  const logs = [];
  const child = spawn(process.execPath, [SRC], { env: { ...process.env, PORT: String(port), OLLAMA_URL: ollamaUrl, OLLAMA_MODEL: model, ORDINEX_DATA_DIR: dataDir, OLLAMA_TIMEOUT_MS: '60000', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(String(d))); child.stderr.on('data', (d) => logs.push(String(d)));
  await waitHealthy(port);
  const api = {
    port, dataDir, logs, base: `http://127.0.0.1:${port}`,
    stop: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill(); }),
    restart: async () => { await api.stop(); const n = await startBackend({ port, ollamaUrl, dataDir, model, env }); Object.assign(api, n); },
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
    assessments: () => fs.existsSync(path.join(dataDir, 'assessments')) ? fs.readdirSync(path.join(dataDir, 'assessments')).filter((f) => f.endsWith('.json')) : [],
  };
  return api;
}

/** Stand-in for Firebase Hosting: serves ord/public on its own origin with the same catch-all rewrite to ordinex.html. */
function startHostedStub(port) {
  const pub = path.join(__dirname, '..', '..', '..', 'public');
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = path.join(pub, p === '/' ? 'ordinex.html' : p);
    if (!f.startsWith(pub) || !fs.existsSync(f) || !fs.statSync(f).isFile()) f = path.join(pub, 'ordinex.html');   // rewrite ** -> /ordinex.html
    const ext = path.extname(f);
    res.writeHead(200, { 'Content-Type': ext === '.js' ? 'text/javascript' : 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ origin: `http://hosted.test:${port}`, close: () => new Promise((r) => srv.close(r)) })));
}

/** Serves ord/public for the EMULATOR suite with a FAKE Firebase config (project demo-ordinex), so the real project is never addressed. */
function startConfiguredApp(port) {
  const pub = process.env.ORDINEX_PUBLIC_DIR || path.join(__dirname, '..', '..', '..', 'public');   // override only for negative-control runs
  const FAKE = ['const firebaseConfig = {', '  apiKey: "fake-api-key",', '  authDomain: "demo-ordinex.firebaseapp.com",', '  projectId: "demo-ordinex",', '  storageBucket: "",', '  messagingSenderId: "0",', '  appId: "1:0:web:0",', '};'].join(String.fromCharCode(10));
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = path.join(pub, p === '/' ? 'ordinex.html' : p);
    if (!f.startsWith(pub) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
    let body = fs.readFileSync(f);
    if (path.basename(f) === 'ordinex.html') body = Buffer.from(body.toString('utf8').replace(/const firebaseConfig = \{[\s\S]*?\};/, () => FAKE), 'utf8');
    res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) })));
}

module.exports = { startConfiguredApp, startHostedStub, startFakeOllama, startBackend, fixture, waitHealthy };
