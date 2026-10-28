'use strict';
// Level 3: REAL browser -> REAL backend -> REAL Ollama (qwen3:4b). No mocks anywhere in this file.
// Run with: npm run ai:ui:test:e2e   (takes a few minutes; first call loads the model)
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { startBackend, fixture } = require('./helpers/env');

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
let be;
test.beforeAll(async () => {
  const v = await fetch(`${OLLAMA}/api/tags`).then((r) => r.json()).catch(() => null);
  test.skip(!v, `Ollama is not reachable at ${OLLAMA}`);
  test.skip(!v.models.some((m) => m.name === 'qwen3:4b'), 'qwen3:4b is not installed (ollama pull qwen3:4b)');
  be = await startBackend({ port: 8821, ollamaUrl: OLLAMA });
});
test.afterAll(async () => { if (be) { await be.stop(); be.cleanup(); } });

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

test('real PDF -> browser UI -> local qwen3:4b -> validated results -> report downloads', async ({ page }) => {
  const problems = []; const hosts = new Set();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('request', (r) => hosts.add(new URL(r.url()).hostname));

  await page.goto(`${be.base}/local-assess.html`);
  await expect(page.locator('#health-status')).toContainText('Local AI ready: qwen3:4b');
  await page.getByLabel('Documents (PDF, DOCX or TXT)').setInputFiles(fixture('policy.pdf'));
  await expect(page.locator('#file-list')).toContainText('policy.pdf');
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.locator('#progress-text')).toContainText(/Analysing|Uploading|Starting/, { timeout: 30000 });
  await expect(page.locator('#results')).toBeVisible({ timeout: 300000 });

  const id = page.url().split('#')[1];
  expect(id).toMatch(/^asm-[0-9a-f]{10}$/);
  const snap = JSON.parse(fs.readFileSync(`${be.dataDir}/assessments/${id}.json`, 'utf8'));   // the persisted source of truth

  // 1. Real local inference occurred (recorded by the backend from Ollama's own response counters).
  expect(snap.model.name).toBe('qwen3:4b');
  expect(snap.model.stats.calls).toBeGreaterThan(0);
  expect(snap.model.stats.promptTokens).toBeGreaterThan(0);
  expect(snap.model.stats.outputTokens).toBeGreaterThan(0);
  const ps = await (await fetch(`${OLLAMA}/api/ps`)).json();
  console.log(`[e2e] model calls=${snap.model.stats.calls} promptTokens=${snap.model.stats.promptTokens} outputTokens=${snap.model.stats.outputTokens} processor=${snap.model.processor} loadedNow=${ps.models.map((m) => m.name).join(',') || 'none (already unloaded)'}`);

  // 2. Validation properties (not exact wording): every cited quote exists verbatim in the uploaded document,
  //    every reference resolves, traceability valid, risk is the deterministic formula.
  expect(snap.traceability.valid).toBe(true);
  // Independent extraction in a plain Node process (Playwright's transform cannot load evidence-model.js, which
  // has a duplicate function declaration that is legal in sloppy-mode CommonJS).
  const out = require('node:child_process').spawnSync(process.execPath, ['-e', "require('./src/documents').ingest({filename:'p.pdf',buffer:require('fs').readFileSync(process.argv[1])}).then(d=>console.log(JSON.stringify(d.chunks.map(c=>c.text))))", fixture('policy.pdf')], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });
  const allDoc = norm(JSON.parse(out.stdout).join(' '));
  expect(allDoc.length).toBeGreaterThan(50);
  for (const f of snap.findings) {
    for (const e of f.evidence) expect(allDoc).toContain(norm(e.quote));
    expect(snap.provisions.some((p) => p.id === f.provisionId && p.sourceId === f.sourceId)).toBe(true);
    const r = snap.risks.find((x) => x.findingId === f.id);
    expect(r.score).toBeGreaterThanOrEqual(0); expect(r.score).toBeLessThanOrEqual(100);
    if (f.status !== 'Insufficient evidence') expect(f.evidence.length).toBeGreaterThan(0);   // verdicts need verified evidence
    if (f.status === 'Insufficient evidence' && f.decidedBy === 'retrieval-rule') expect(f.evidence.length).toBe(0);
  }
  // Expected, independently reviewable properties of this synthetic document: it documents AES-256 encryption
  // and a 72-hour authority notification, and says nothing about retention or impact assessments.
  const by = (pid) => snap.findings.find((f) => f.provisionId === pid);
  expect(['Compliant', 'Partially compliant']).toContain(by('gdpr-art-32').status);
  expect(['Compliant', 'Partially compliant']).toContain(by('gdpr-art-33').status);
  expect(by('gdpr-art-5-1-e').status).toBe('Insufficient evidence');
  expect(by('gdpr-art-35').status).toBe('Insufficient evidence');
  expect(snap.counts['Non-compliant']).toBe(0);

  // 3. The UI shows exactly what the snapshot contains.
  for (const f of snap.findings) {
    const card = page.locator(`[data-finding="${f.provisionId}"]`);
    await expect(card).toContainText(f.status);
    const r = snap.risks.find((x) => x.findingId === f.id);
    await expect(card).toContainText(`Risk ${r.score} (${r.level})`);
    for (const e of f.evidence) await expect(card).toContainText(e.quote.slice(0, 25));
  }
  await expect(page.locator('#overall-risk')).toContainText(String(snap.riskSummary.overall));

  // 4. Report downloads (md/html/json) are real files for THIS assessment.
  for (const [label, ext, needle] of [['Markdown', 'md', snap.hash], ['HTML', 'html', snap.id], ['JSON', 'json', snap.hash]]) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: `Download ${label}` }).click()]);
    expect(dl.suggestedFilename()).toBe(`ordinex-${id}.${ext}`);
    expect(fs.readFileSync(await dl.path(), 'utf8')).toContain(needle);
  }

  // 5. Local-only: the page talked to loopback only; no console errors; backend log has no document text.
  expect([...hosts].filter((h) => !['127.0.0.1', 'localhost'].includes(h))).toEqual([]);
  expect(problems).toEqual([]);
  expect(be.logs.join('')).not.toMatch(/AES-256|supervisory authority/);
});
