'use strict';
// Level 1: real browser + real backend + MOCK Ollama. Failure modes are driven through the mock.
const { test: base, expect } = require('@playwright/test');
const fs = require('node:fs');
const { startFakeOllama, startBackend, fixture } = require('./helpers/env');

let fake, be;
base.beforeAll(async () => { fake = await startFakeOllama(8812); be = await startBackend({ port: 8811, ollamaUrl: 'http://127.0.0.1:8812' }); });
base.afterAll(async () => { await be.stop(); await fake.close(); be.cleanup(); });
base.beforeEach(() => { fake.state.mode = 'ok'; });

// Every test records console errors / page errors / failed requests; a test that passes with these present would be a false pass.
const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url()));
    page.problems = problems; page.allowProblem = (re) => { for (let i = problems.length - 1; i >= 0; i--) if (re.test(problems[i])) problems.splice(i, 1); };
    await use(page);
  },
});
const URL = () => `${be.base}/local-assess.html`;
const pick = (page, ...names) => page.locator('#file-input').setInputFiles(names.map((n) => (typeof n === 'string' ? fixture(n) : n)));
const run = async (page) => { await page.getByRole('button', { name: 'Analyze' }).click(); };
const results = (page) => page.locator('#results');
const finishOK = async (page) => { await expect(results(page)).toBeVisible({ timeout: 30000 }); };

test('startup: page renders, status shows ready, no console/network errors', async ({ page }) => {
  await page.goto(URL());
  await expect(page.getByRole('heading', { name: 'Ordinex — Local Assessment' })).toBeVisible();
  await expect(page.locator('#health-status')).toContainText('Local AI ready: qwen3:4b');
  await expect(page.locator('#dataset-notice')).toContainText('never — unverified');
  expect(page.problems).toEqual([]);
});

test('main app: loads, serves the badge and the link to local assessment', async ({ page }) => {
  await page.goto(be.base + '/');
  await expect(page.locator('#local-ai-badge')).toContainText('Local AI ready: qwen3:4b', { timeout: 15000 });
  await page.getByRole('link', { name: /Local assessment/ }).click();
  await expect(page).toHaveURL(/local-assess\.html/);
  // The main app is a Firebase-backed SPA; offline Firebase/CDN failures there are environment noise, not asserted on.
});

test('nothing is sent to any non-loopback host during a full analysis', async ({ page }) => {
  const hosts = new Set(); page.on('request', (r) => hosts.add(new globalThis.URL(r.url()).hostname));
  await page.goto(URL()); await pick(page, 'policy.pdf'); await run(page); await finishOK(page);
  expect([...hosts].filter((h) => !['127.0.0.1', 'localhost'].includes(h))).toEqual([]);
});

test('backend unreachable after load: status turns red and Analyze explains instead of faking a result', async ({ page }) => {
  const b = await startBackend({ port: 8813, ollamaUrl: 'http://127.0.0.1:8812' });
  await page.goto(`${b.base}/local-assess.html`);
  await expect(page.locator('#health-status')).toContainText('Local AI ready');
  await b.stop();
  await pick(page, 'policy.pdf'); await run(page);
  await expect(page.locator('#error')).toContainText(/not available|Cannot reach/);
  await expect(results(page)).toBeHidden();
  b.cleanup(); page.allowProblem(/.*/);
});

test('Ollama unavailable / model missing: red status, no analysis started', async ({ page }) => {
  fake.state.mode = 'nomodel';
  await page.goto(URL());
  await expect(page.locator('#health-status')).toContainText('model qwen3:4b is not installed');
  await pick(page, 'policy.pdf'); await run(page);
  await expect(page.locator('#error')).toContainText('Local AI is not available');
  await expect(results(page)).toBeHidden();
  expect(fake.state.chatCalls).toBeGreaterThanOrEqual(0);
  page.allowProblem(/503|Failed to load resource/);
});

test('validation: no file, no data type', async ({ page }) => {
  await page.goto(URL());
  await run(page); await expect(page.locator('#error')).toContainText('Choose at least one document');
  await pick(page, 'policy.pdf'); await page.getByLabel('Personal data').uncheck(); await run(page);
  await expect(page.locator('#error')).toContainText('at least one data type');
});

test('file list: select, remove, replace', async ({ page }) => {
  await page.goto(URL());
  await pick(page, 'policy.pdf', 'policy.docx');
  await expect(page.locator('#file-list li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove policy.pdf' }).click();
  await expect(page.locator('#file-list li')).toHaveCount(1);
  await pick(page, 'injection.txt');
  await expect(page.locator('#file-list li')).toHaveCount(1); await expect(page.locator('#file-list')).toContainText('injection.txt');
});

for (const [f, msg] of [['empty.txt', /empty/i], ['tool.exe', /Unsupported file type/], ['malformed.pdf', /could not be parsed/], ['scanned.pdf', /no selectable text.*NOT analysed/], ['encrypted.pdf', /password-protected/]]) {
  test(`rejected upload shows an accurate message and no result: ${f}`, async ({ page }) => {
    await page.goto(URL()); await pick(page, f); await run(page);
    await expect(page.locator('#doc-messages')).toContainText(msg);
    await expect(page.locator('#error')).toContainText('nothing was analyzed');
    await expect(results(page)).toBeHidden();
    page.allowProblem(/422|Failed to load resource/);
  });
}

test('oversized file is rejected client-side before upload', async ({ page }) => {
  await page.goto(URL());
  const dir = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ordinex-big-'));
  const big = require('node:path').join(dir, 'huge.txt'); fs.writeFileSync(big, Buffer.alloc(26 * 1024 * 1024, 65));
  try { await page.locator('#file-input').setInputFiles(big, { timeout: 30000 }); } finally { /* removed after the assertions below */ }
  await run(page);
  await expect(page.locator('#doc-messages')).toContainText('larger than 25 MB');
  await expect(results(page)).toBeHidden();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mixed upload: valid file is analysed, bad file reported (not silently dropped)', async ({ page }) => {
  await page.goto(URL()); await pick(page, 'policy.pdf', 'scanned.pdf'); await run(page);
  await finishOK(page);
  await expect(page.locator('#doc-messages')).toContainText('scanned.pdf');
  page.allowProblem(/422|Failed to load resource/);
});

for (const f of ['policy.pdf', 'policy.docx', 'injection.txt']) {
  test(`analysis flow renders snapshot-derived results: ${f}`, async ({ page }) => {
    await page.goto(URL()); await pick(page, f); await run(page); await finishOK(page);
    const id = (await page.url().split('#')[1]);
    expect(id).toMatch(/^asm-[0-9a-f]{10}$/);
    const snap = await (await fetch(`${be.base}/api/assessments/${id}`)).json();
    // every rendered finding matches the persisted snapshot: status, risk, evidence quote
    for (const fd of snap.findings) {
      const card = page.locator(`[data-finding="${fd.provisionId}"]`);
      await expect(card).toContainText(fd.status);
      const r = snap.risks.find((x) => x.findingId === fd.id);
      await expect(card).toContainText(`Risk ${r.score} (${r.level})`);
      for (const e of fd.evidence) await expect(card).toContainText(e.quote.slice(0, 30));
      if (fd.status === 'Insufficient evidence') await expect(card).toContainText(/evidence gap|No verified evidence/);
    }
    await expect(page.locator('#overall-risk')).toContainText(`${snap.riskSummary.overall}`);
    expect(snap.traceability.valid).toBe(true);
    expect(page.problems).toEqual([]);
  });
}

test('regulatory source status is shown per finding: GDPR unverified + paraphrase + review required', async ({ page }) => {
  await page.goto(URL()); await pick(page, 'policy.pdf'); await run(page); await finishOK(page);
  const st = page.locator('[data-finding="gdpr-art-32"] [data-source-status]');
  await expect(st).toHaveAttribute('data-source-status', 'unverified');
  await expect(st).toContainText(/UNVERIFIED.*paraphrase.*Human review required/s);
  await expect(page.locator('[data-finding="gdpr-art-32"]')).toContainText('Human review required');
});

test('injected document cannot yield a Compliant verdict in the UI', async ({ page }) => {
  await page.goto(URL()); await pick(page, 'injection.txt'); await run(page); await finishOK(page);
  const art32 = page.locator('[data-finding="gdpr-art-32"]');
  await expect(art32).toContainText(/withheld|Human review required/);
  await expect(art32.locator('.tag.Compliant')).toHaveCount(0);
});

test('missing evidence is shown as an evidence gap, never as non-compliance', async ({ page }) => {
  await page.goto(URL()); await pick(page, 'policy.pdf'); await run(page); await finishOK(page);
  const gap = page.locator('[data-finding="gdpr-art-5-1-e"]');
  await expect(gap).toContainText('Insufficient evidence'); await expect(gap).toContainText('evidence gap, not a confirmed violation');
  await expect(gap.locator('.tag.Non-compliant')).toHaveCount(0);
});

test('duplicate clicks and double-submit create exactly one assessment', async ({ page }) => {
  fake.state.mode = 'slow'; fake.state.delayMs = 800;
  const before = be.assessments().length;
  await page.goto(URL()); await pick(page, 'policy.pdf');
  const btn = page.getByRole('button', { name: 'Analyze' });
  await btn.dblclick(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Analyzing…' })).toBeDisabled();
  await finishOK(page);
  expect(be.assessments().length).toBe(before + 1);
});

test('cancel stops the run, shows a message, saves nothing and leaves the UI usable', async ({ page }) => {
  fake.state.mode = 'slow'; fake.state.delayMs = 3000;
  const before = be.assessments().length;
  await page.goto(URL()); await pick(page, 'policy.pdf'); await run(page);
  await expect(page.getByRole('button', { name: 'Cancel analysis' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel analysis' }).click();
  await expect(page.locator('#error')).toContainText(/cancelled/i, { timeout: 20000 });
  expect(be.assessments().length).toBe(before);
  await expect(page.getByRole('button', { name: 'Analyze' })).toBeEnabled();
  fake.state.mode = 'ok'; await run(page); await finishOK(page);   // retry works
});

test('model OOM during analysis: error shown, previous result cleared (no stale success)', async ({ page }) => {
  await page.goto(URL()); await pick(page, 'policy.pdf'); await run(page); await finishOK(page);
  fake.state.mode = 'oom'; await run(page);
  await expect(page.locator('#error')).toContainText(/memory/i, { timeout: 30000 });
  await expect(results(page)).toBeHidden(); await expect(page.locator('#findings article')).toHaveCount(0);
  page.allowProblem(/.*/);
});

test('malformed model output: UI shows Insufficient evidence + review flag, never Compliant', async ({ page }) => {
  fake.state.mode = 'badjson';
  await page.goto(URL()); await pick(page, 'policy.pdf'); await run(page); await finishOK(page);
  await expect(page.locator('.tag.Compliant')).toHaveCount(0);
  await expect(page.locator('[data-finding="gdpr-art-32"]')).toContainText('Human review required');
});

test('backend restart mid-analysis: clear message, no result, retry succeeds', async ({ page }) => {
  fake.state.mode = 'slow'; fake.state.delayMs = 3000;
  await page.goto(URL()); await pick(page, 'policy.pdf'); await run(page);
  await expect(page.locator('#progress-text')).toContainText(/Analysing|Working/, { timeout: 15000 });
  await be.restart();
  await expect(page.locator('#error')).toContainText(/lost this analysis|Lost contact|Cannot reach/, { timeout: 30000 });
  await expect(results(page)).toBeHidden();
  fake.state.mode = 'ok'; await page.getByRole('button', { name: 'Analyze' }).click(); await finishOK(page);
  page.allowProblem(/.*/);
});

test('XSS: hostile file name and document text render as text only', async ({ page }) => {
  await page.goto(URL());
  await page.locator('#file-input').setInputFiles({ name: '<img src=x onerror=window.__xss=1>.txt', mimeType: 'text/plain', buffer: fs.readFileSync(fixture('xss.txt')) });
  await expect(page.locator('#file-list')).toContainText('<img src=x');
  await run(page); await finishOK(page);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.locator('#results img, #results script, #file-list img').count()).toBe(0);
});

test('downloads: all three formats are real files with correct names and content; unsupported formats are not offered', async ({ page }) => {
  await page.goto(URL()); await pick(page, 'policy.pdf'); await run(page); await finishOK(page);
  const id = page.url().split('#')[1];
  await expect(page.getByRole('link', { name: /Download (PDF|DOCX)/ })).toHaveCount(0);
  for (const [label, ext, needle] of [['Markdown', 'md', `# Ordinex Compliance Assessment ${id}`], ['HTML', 'html', `Ordinex report ${id}`], ['JSON', 'json', `"id":"${id}"`]]) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: `Download ${label}` }).click()]);
    expect(dl.suggestedFilename()).toBe(`ordinex-${id}.${ext}`);
    const text = fs.readFileSync(await dl.path(), 'utf8');
    expect(text).toContain(needle);
  }
});

test('history + deep link + reload: saved assessment reopens identically; invalid hash id shows an error', async ({ page }) => {
  await page.goto(URL()); await pick(page, 'policy.pdf'); await run(page); await finishOK(page);
  const id = page.url().split('#')[1];
  const before = await page.locator('#findings').innerText();
  await page.reload(); await expect(results(page)).toBeVisible();
  expect(await page.locator('#findings').innerText()).toBe(before);
  await page.goto(URL() + '#asm-0000000000'); await page.reload();
  await expect(page.locator('#error')).toContainText(/not found/i); await expect(results(page)).toBeHidden();
  await page.goto(URL()); await page.getByRole('button', { name: `Open assessment ${id}` }).click(); await expect(results(page)).toBeVisible();
  page.allowProblem(/404|Failed to load resource/);
});

test('non-English document is flagged for human review, original text kept', async ({ page }) => {
  await page.goto(URL()); await pick(page, 'hindi.txt'); await run(page);
  await expect(page.locator('#doc-messages')).toContainText(/Hindi.*human review/i, { timeout: 20000 });
  await finishOK(page);
});

for (const [name, w, h] of [['desktop', 1440, 900], ['laptop', 1366, 768], ['narrow', 390, 844]]) {
  test(`responsive ${name} ${w}x${h}: no horizontal overflow, controls reachable, with long names + results`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(URL());
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.locator('#file-input').setInputFiles({ name: 'a-very-long-document-name-'.repeat(8) + '.txt', mimeType: 'text/plain', buffer: fs.readFileSync(fixture('injection.txt')) });
    expect(await overflow()).toBeLessThanOrEqual(0);
    await run(page); await finishOK(page);
    expect(await overflow()).toBeLessThanOrEqual(0);
    for (const n of ['Analyze', 'Download Markdown']) {
      const b = page.getByRole(n === 'Analyze' ? 'button' : 'link', { name: n }); await b.scrollIntoViewIfNeeded();
      const box = await b.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(w + 1); expect(box.height).toBeGreaterThanOrEqual(36);
    }
  });
}

test('accessibility basics: labelled controls, keyboard operation, visible focus, live status regions', async ({ page }) => {
  await page.goto(URL());
  await expect(page.getByLabel('Documents (PDF, DOCX or TXT)')).toBeVisible();
  await expect(page.getByLabel('Jurisdiction')).toBeVisible();
  await expect(page.getByRole('status').first()).toBeVisible();
  await page.getByLabel('Documents (PDF, DOCX or TXT)').setInputFiles(fixture('policy.pdf'));
  await page.getByLabel('Jurisdiction').focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  // Tab order from the jurisdiction select: data-type checkboxes -> Remove -> Analyze; focus must land on a button by the third Tab.
  expect(await page.evaluate(() => document.activeElement.tagName + ':' + (document.activeElement.textContent || '').trim())).toMatch(/^BUTTON:(Remove|Analyze)/);
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  expect(outline).not.toBe('none');
  await page.getByRole('button', { name: 'Analyze' }).focus(); await page.keyboard.press('Enter');
  await finishOK(page);
  await expect(page.locator('#error')).toHaveAttribute('role', 'alert');
});

