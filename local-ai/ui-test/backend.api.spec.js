'use strict';
// Level 2: real backend over HTTP, MOCK Ollama, isolated temp data dir.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { startFakeOllama, startBackend, fixture } = require('./helpers/env');

let fake, be;
test.beforeAll(async () => { fake = await startFakeOllama(8802); be = await startBackend({ port: 8801, ollamaUrl: 'http://127.0.0.1:8802' }); });
test.afterAll(async () => { await be.stop(); await fake.close(); be.cleanup(); });

const upload = (name, buf) => fetch(`${be.base}/api/documents`, { method: 'POST', headers: { 'X-Filename': encodeURIComponent(name) }, body: buf });
const profile = { jurisdictions: ['EU'], dataTypes: ['personal'] };
async function analyze(ids) {
  const r = await fetch(`${be.base}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile, documentIds: ids }) });
  return r;
}
async function finish(jobId) {
  for (;;) { const j = await (await fetch(`${be.base}/api/jobs/${jobId}`)).json(); if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 200)); }
}

test('health reports backend, fake model and dataset coverage', async () => {
  const j = await (await fetch(`${be.base}/api/health`)).json();
  expect(j.backend).toBe('ok'); expect(j.aiAvailable).toBe(true); expect(j.dataset.lastVerified).toBeNull(); expect(j.ocrAvailable).toBe(false);
});

test('upload statuses: pdf/docx/txt parsed; empty, unsupported, malformed, scanned, encrypted rejected accurately', async () => {
  const exp = { 'policy.pdf': [200, 'parsed'], 'policy.docx': [200, 'parsed'], 'injection.txt': [200, 'parsed'], 'empty.txt': [422, 'empty'], 'tool.exe': [422, 'unsupported'], 'malformed.pdf': [422, 'malformed'], 'scanned.pdf': [422, 'needs-ocr'], 'encrypted.pdf': [422, 'encrypted'] };
  for (const [f, [code, status]] of Object.entries(exp)) {
    const r = await upload(f, fs.readFileSync(fixture(f)));
    const j = await r.json();
    expect([f, r.status, j.status]).toEqual([f, code, status]);
  }
});

test('oversized upload -> 413; malformed JSON -> 400; unknown format -> 400; unknown/invalid ids -> 404', async () => {
  expect((await upload('big.txt', Buffer.alloc(26 * 1024 * 1024, 65))).status).toBe(413);
  expect((await fetch(`${be.base}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' })).status).toBe(400);
  expect((await analyze([])).status).toBe(400);
  expect((await fetch(`${be.base}/api/assessments/asm-0000000000`)).status).toBe(404);
  expect((await fetch(`${be.base}/api/assessments/..%2f..%2fpackage`)).status).toBe(404);
  expect((await fetch(`${be.base}/api/jobs/nope`)).status).toBe(404);
  expect((await fetch(`${be.base}/api/ai/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
});

test('static path traversal and secrets are not served', async () => {
  for (const u of ['/..%2f.env', '/%2e%2e/%2e%2e/.env', '/..%2f..%2fdata/assessments', '/.env', '/%00', '/%E0%A4%A']) {
    const r = await fetch(`${be.base}${u}`);
    expect([u, r.status < 400 ? 'served' : 'blocked']).toEqual([u, 'blocked']);
  }
  const root = await fetch(`${be.base}/`); expect(root.status).toBe(200);
  expect(root.headers.get('x-content-type-options')).toBe('nosniff');
  // The frontend must not carry an AI key and the cloud path must be off. (The Firebase web
  // apiKey is a public client identifier by design and is intentionally not asserted on.)
  const html = await root.text();
  expect(html).toMatch(/const geminiConfig = \{\s*allowCloud: false,\s*apiKey: "",/);
  expect(html).not.toMatch(/AQ\.Ab8R/);
});

test('Host header must be loopback (DNS-rebinding guard) and foreign origins get no CORS grant', async () => {
  const status = await new Promise((res) => { const rq = http.request({ host: '127.0.0.1', port: 8801, path: '/api/health', headers: { Host: 'evil.example' } }, (r) => { r.resume(); res(r.statusCode); }); rq.end(); });
  expect(status).toBe(403);
  const r = await fetch(`${be.base}/api/health`, { headers: { Origin: 'https://evil.example' } });
  expect(r.headers.get('access-control-allow-origin')).toBeNull();
  const ok = await fetch(`${be.base}/api/health`, { headers: { Origin: 'http://localhost:3000' } });
  expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
});

test('full API flow: upload -> analyze -> persisted snapshot -> reports with correct headers', async () => {
  const d = await (await upload('policy.pdf', fs.readFileSync(fixture('policy.pdf')))).json();
  const r = await analyze([d.id]); expect(r.status).toBe(202);
  const { jobId } = await r.json();
  const job = await finish(jobId); expect(job.status).toBe('done');
  expect(be.assessments()).toContain(`${job.assessmentId}.json`);
  const snap = await (await fetch(`${be.base}/api/assessments/${job.assessmentId}`)).json();
  expect(snap.traceability.valid).toBe(true);
  expect(snap.findings.length).toBeGreaterThan(0);
  const base = `${be.base}/api/assessments/${job.assessmentId}/report`;
  const md = await fetch(`${base}?format=md&download=1`);
  expect(md.headers.get('content-type')).toContain('text/markdown'); expect(md.headers.get('content-disposition')).toContain(`ordinex-${job.assessmentId}.md`);
  expect(await md.text()).toContain(snap.hash);
  const html = await fetch(`${base}?format=html`); expect(html.headers.get('content-type')).toContain('text/html'); expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");
  const js = await fetch(`${base}?format=json&download=1`); expect((await js.json()).id).toBe(job.assessmentId);
  for (const bad of ['pdf', 'docx']) expect((await fetch(`${base}?format=${bad}`)).status).toBe(400);
});

test('second analysis while one is running -> 409 (no duplicate assessments)', async () => {
  fake.state.mode = 'slow'; fake.state.delayMs = 1500;
  try {
    const d = await (await upload('policy.pdf', fs.readFileSync(fixture('policy.pdf')))).json();
    const before = be.assessments().length;
    const a = await analyze([d.id]); expect(a.status).toBe(202);
    const b = await analyze([d.id]); expect(b.status).toBe(409);
    await finish((await a.json()).jobId);
    expect(be.assessments().length).toBe(before + 1);
  } finally { fake.state.mode = 'ok'; }
});

test('HTML report escapes untrusted document and file-name text', async () => {
  const d = await (await upload('<img src=x onerror=alert(1)>.txt', fs.readFileSync(fixture('xss.txt')))).json();
  expect(d.name).not.toMatch(/[<>]/);
  const { jobId } = await (await analyze([d.id])).json();
  const job = await finish(jobId); expect(job.status).toBe('done');
  const html = await (await fetch(`${be.base}/api/assessments/${job.assessmentId}/report?format=html`)).text();
  expect(html).not.toMatch(/<img |<script/i);
});

test('saved-assessment robustness: corrupt file is skipped in the list and reported as 422; list stays usable', async () => {
  const dir = path.join(be.dataDir, 'assessments');
  fs.writeFileSync(path.join(dir, 'asm-deadbeef00.json'), '{ truncated');
  const list = await (await fetch(`${be.base}/api/assessments`)).json();
  expect(Array.isArray(list)).toBe(true); expect(list.every((x) => x.id !== undefined)).toBe(true);
  expect((await fetch(`${be.base}/api/assessments/asm-deadbeef00`)).status).toBe(422);
  expect((await fetch(`${be.base}/api/assessments/asm-deadbeef00/report?format=md`)).status).toBe(422);
});

test('persistence: assessments survive a backend restart unchanged', async () => {
  const list = await (await fetch(`${be.base}/api/assessments`)).json();
  const id = list[0].id; const before = await (await fetch(`${be.base}/api/assessments/${id}`)).text();
  await be.restart();
  expect(await (await fetch(`${be.base}/api/assessments/${id}`)).text()).toBe(before);
});

test('model failures: bad JSON never becomes a verdict; 500/OOM abort the run honestly; model missing -> 503', async () => {
  const d = await (await upload('policy.pdf', fs.readFileSync(fixture('policy.pdf')))).json();
  fake.state.mode = 'badjson';
  let job = await finish((await (await analyze([d.id])).json()).jobId);
  expect(job.status).toBe('done');
  const snap = await (await fetch(`${be.base}/api/assessments/${job.assessmentId}`)).json();
  expect(snap.findings.every((f) => f.status === 'Insufficient evidence')).toBe(true);
  expect(snap.findings.some((f) => f.reviewRequired)).toBe(true);
  fake.state.mode = 'oom';
  job = await finish((await (await analyze([d.id])).json()).jobId);
  expect(job.status).toBe('failed'); expect(job.error.code).toBe('out-of-memory');
  fake.state.mode = 'nomodel';
  const r = await analyze([d.id]); expect(r.status).toBe(503); expect((await r.json()).code).toBe('model-missing');
  fake.state.mode = 'ok';
});

test('Ollama unreachable -> 503 with install hint; backend itself stays up', async () => {
  const be2 = await startBackend({ port: 8804, ollamaUrl: 'http://127.0.0.1:9' });
  try {
    const d = await (await fetch(`${be2.base}/api/documents`, { method: 'POST', headers: { 'X-Filename': 'a.txt' }, body: 'Data is encrypted at rest using AES-256.' })).json();
    const r = await fetch(`${be2.base}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile, documentIds: [d.id] }) });
    expect(r.status).toBe(503); expect((await r.json()).code).toBe('unreachable');
    const gen = await fetch(`${be2.base}/api/ai/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }) });
    expect(gen.status).toBe(503);
    expect((await fetch(`${be2.base}/`)).status).toBe(200);
  } finally { await be2.stop(); be2.cleanup(); }
});

test('port conflict prints a useful error and exits non-zero', async () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, PORT: '8801' }, encoding: 'utf8', timeout: 10000 });
  expect(r.status).not.toBe(0); expect(r.stderr).toMatch(/already in use/);
});

test('logs never contain document text', async () => {
  expect(be.logs.join('')).not.toMatch(/AES-256|supervisory authority/);
});
