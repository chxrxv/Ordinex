'use strict';
// "Hosted" mode: the pages are served from a DIFFERENT origin than the backend (as on Firebase Hosting).
// Mock Ollama; real backend; real browser. Proves the connect flow, the origin allowlist and honest status.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { startFakeOllama, startBackend, startHostedStub, fixture } = require('./helpers/env');

// hosted.test is a NON-loopback hostname mapped to 127.0.0.1 inside the test browser only, so the pages see a genuinely different origin.
test.use({ launchOptions: { args: ['--host-resolver-rules=MAP hosted.test 127.0.0.1'] } });

let fake, hosted, allowed, closed;
test.beforeAll(async () => {
  fake = await startFakeOllama(8842);
  hosted = await startHostedStub(8841);
  allowed = await startBackend({ port: 8843, ollamaUrl: 'http://127.0.0.1:8842', env: { ORDINEX_ALLOWED_ORIGINS: hosted.origin } });
  closed = await startBackend({ port: 8844, ollamaUrl: 'http://127.0.0.1:8842' });                // default: loopback only
});
test.afterAll(async () => { await allowed.stop(); await closed.stop(); await fake.close(); await hosted.close(); allowed.cleanup(); closed.cleanup(); });

const connect = async (page, url) => { await page.getByLabel('Local backend address').fill(url); await page.getByRole('button', { name: 'Connect' }).click(); };

test('hosted page, not connected: explains that the website cannot run AI, sends no request to any backend, refuses to analyze', async ({ page }) => {
  const reqs = []; page.on('request', (r) => reqs.push(r.url()));
  await page.goto(`${hosted.origin}/local-assess.html`);
  await expect(page.getByRole('heading', { name: 'Connect to Ordinex on your computer' })).toBeVisible();
  await expect(page.locator('#health-status')).toContainText('Not connected');
  await expect(page.locator('#health-status')).not.toContainText('ready');
  await page.locator('#file-input').setInputFiles(fixture('policy.pdf'));
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.locator('#error')).toContainText(/not (available|connected)/i);
  expect(reqs.filter((u) => /:(8843|8844|8787)\//.test(u))).toEqual([]);
});

test('connect panel refuses non-loopback addresses (documents can never be pointed at a remote server)', async ({ page }) => {
  const reqs = []; page.on('request', (r) => reqs.push(r.url()));
  await page.goto(`${hosted.origin}/local-assess.html`);
  for (const bad of ['https://evil.example', 'http://192.168.1.20:8787', 'http://127.0.0.1.evil.example:8787', 'javascript:alert(1)']) {
    await connect(page, bad); await expect(page.locator('#error')).toContainText('Only loopback addresses');
  }
  expect(reqs.filter((u) => /evil|192\.168/.test(u))).toEqual([]);
});

test('backend that has NOT allowed this origin: connection fails with the exact fix, backend answers 403', async ({ page }) => {
  await page.goto(`${hosted.origin}/local-assess.html`);
  await connect(page, closed.base);
  await expect(page.locator('#error')).toContainText('ORDINEX_ALLOWED_ORIGINS=' + hosted.origin);
  await expect(page.locator('#health-status')).not.toContainText('ready');
  const r = await fetch(`${closed.base}/api/health`, { headers: { Origin: hosted.origin } });
  expect(r.status).toBe(403);
});

test('opted-in backend: connect, analyze a PDF cross-origin, results + downloads work; connection survives reload', async ({ page }) => {
  await page.goto(`${hosted.origin}/local-assess.html`);
  await connect(page, allowed.base);
  await expect(page.locator('#health-status')).toContainText('Local AI ready', { timeout: 15000 });
  await page.locator('#file-input').setInputFiles(fixture('policy.pdf'));
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.locator('#results')).toBeVisible({ timeout: 30000 });
  const id = page.url().split('#')[1];
  expect(allowed.assessments()).toContain(`${id}.json`);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download JSON' }).click()]);
  expect(dl.suggestedFilename()).toBe(`ordinex-${id}.json`);
  expect(JSON.parse(fs.readFileSync(await dl.path(), 'utf8')).id).toBe(id);
  await page.goto(`${hosted.origin}/local-assess.html#${id}`);       // fresh load: stored connection + deep link
  await expect(page.locator('#results')).toBeVisible({ timeout: 15000 });
});

test('main app on a hosted origin: badge is RED until the user connects; never green on its own', async ({ page }) => {
  await page.goto(`${hosted.origin}/`);
  const badge = page.locator('#local-ai-badge');
  await expect(badge).toContainText('Local AI not connected');
  expect(await badge.evaluate((e) => e.style.background)).not.toContain('17, 107, 58');   // not the green state
  page.once('dialog', (d) => d.accept(allowed.base));
  await badge.click();
  await expect(badge).toContainText('Local AI ready', { timeout: 15000 });
});

test('backend API: foreign Origin cannot POST; allowlisted origin gets CORS + Private-Network headers; nothing stored for the foreign call', async () => {
  const before = (await (await fetch(`${closed.base}/api/assessments`)).json()).length;
  const evil = await fetch(`${closed.base}/api/documents`, { method: 'POST', headers: { Origin: 'https://evil.example', 'X-Filename': 'a.txt' }, body: 'secret' });
  expect(evil.status).toBe(403);
  const pre = await fetch(`${allowed.base}/api/analyze`, { method: 'OPTIONS', headers: { Origin: hosted.origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' } });
  expect(pre.status).toBe(204);
  expect(pre.headers.get('access-control-allow-origin')).toBe(hosted.origin);
  expect(pre.headers.get('access-control-allow-private-network')).toBe('true');
  expect((await fetch(`${allowed.base}/api/health`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  expect((await (await fetch(`${closed.base}/api/assessments`)).json()).length).toBe(before);
});
