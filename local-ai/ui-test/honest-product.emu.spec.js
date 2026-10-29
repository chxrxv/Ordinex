'use strict';
// Honest-product regression: unverifiable marketing claims stay off the landing page, the regulatory "feed" is labelled as
// sample reference records, System Status never reports an untested integration as healthy, the Security & Audit page
// reflects the real session, and CSV export neutralises spreadsheet formulas. Emulators only (fake demo-ordinex project).
const { test, expect } = require('@playwright/test');
const { startConfiguredApp } = require('./helpers/env');

const PROJECT = 'demo-ordinex';
const AUTH = 'http://127.0.0.1:9099', FS = 'http://127.0.0.1:8081';
const USER = { email: 'honest@acme.test', password: 'correct-horse-9', org: 'Honest Co' };

let app;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  app = await startConfiguredApp(8861);
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
});
test.afterAll(async () => { await app.close(); });

async function wire(page) {
  const prodHits = [];
  await page.addInitScript(() => { window.__FIREBASE_DEFAULTS__ = { emulatorHosts: { auth: '127.0.0.1:9099', firestore: '127.0.0.1:8081' } }; });
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url()); const h = u.hostname;
    if (h === '127.0.0.1' || h === 'localhost') return route.continue();
    if (h === 'identitytoolkit.googleapis.com' || h === 'securetoken.googleapis.com' || h === 'firestore.googleapis.com') {
      const target = (h === 'firestore.googleapis.com' ? FS : `${AUTH}/${h}`) + u.pathname + u.search;
      const cors = { 'access-control-allow-origin': app.origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const resp = await route.fetch({ url: target }); return route.fulfill({ response: resp, headers: { ...resp.headers(), ...cors } });
    }
    if (h === 'fonts.googleapis.com' || h === 'fonts.gstatic.com') return route.continue();
    if (/(googleapis|gstatic|firebaseio|firebaseapp|google)\.com$/.test(h)) { prodHits.push(h); return route.abort(); }
    return route.continue();
  });
  return { prodHits };
}
const body = (page) => page.locator('body').innerText();

test('landing page makes no unverifiable claims', async ({ page }) => {
  const g = await wire(page);
  await page.goto(app.origin + '/');
  const txt = await body(page);
  for (const bad of [/SOC 2/i, /ISO 27001/i, /Trusted by compliance teams/i, /end-to-end encryption/i, /updated in real-time/i, /SSO\/SAML/i, /SLA guarantee/i, /API access/i, /Dedicated account manager/i]) {
    expect(txt, String(bad)).not.toMatch(bad);
  }
  expect(txt).toMatch(/Illustrative sample preview/i);
  expect(txt).toMatch(/not enforced|not currently available|No payment provider/i);
  expect(g.prodHits).toEqual([]);
});

test('signed-in pages: monitoring is honest, status and security pages reflect the real session', async ({ page }) => {
  const g = await wire(page);
  await page.goto(app.origin + '/');
  await page.getByRole('button', { name: /Start Free (Trial|Analysis)/ }).first().click();
  await page.locator('#authOrg').fill(USER.org); await page.locator('#authEmail').fill(USER.email); await page.locator('#authPass').fill(USER.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('#sidebar')).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1500);

  await page.locator('.sb-item', { hasText: 'Monitoring' }).first().click();
  const mon = await body(page);
  expect(mon).toMatch(/No live regulatory change detection is connected/i);
  expect(mon).not.toMatch(/in real-time/i);
  expect(mon).not.toMatch(/Impact Score/);

  await page.locator('.sb-item', { hasText: 'System Status' }).first().click();
  await expect(page.locator('[data-status-key="auth"]')).toContainText('Operational', { timeout: 15000 });
  await expect(page.locator('[data-status-key="firestore"]')).toContainText('Operational');
  // the hosted-style page has no local backend configured: must NOT read as healthy
  await expect(page.locator('[data-status-key="localAi"]')).not.toContainText('Operational');
  await expect(page.locator('[data-status-key="cloudAi"]')).toContainText('Not connected');
  await expect(page.locator('[data-status-key="platform"]')).toContainText('Not applicable');

  await page.locator('.sb-item', { hasText: 'Security & Audit' }).first().click();
  const sec = await body(page);
  expect(sec).toContain(USER.email);
  expect(sec).toMatch(/What is not claimed/i);
  expect(sec).toMatch(/No SOC 2/i);
  expect(sec).toMatch(/Audit trail/i);
  expect(g.prodHits).toEqual([]);
});

test('CSV export neutralises spreadsheet formulas but leaves numbers alone', async ({ page }) => {
  await wire(page);
  await page.goto(app.origin + '/');
  const csv = await page.evaluate(() => {
    let captured = null;
    const orig = URL.createObjectURL; URL.createObjectURL = (b) => { captured = b; return 'blob:x'; };
    HTMLAnchorElement.prototype.click = function () {};
    exportCSV([{ name: '=HYPERLINK("http://evil","x")', n: 42, neg: -5, a: '@SUM(A1)', p: '+1+1', ok: 'plain' }], 'x');
    URL.createObjectURL = orig;
    return captured.text();
  }).then((t) => t);
  expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
  expect(csv).toContain(`"'@SUM(A1)"`);
  expect(csv).toContain(`"'+1+1"`);
  expect(csv).toContain('"42"');
  expect(csv).toContain('"-5"');
  expect(csv).toContain('"plain"');
});

test('failed analysis shows the real error (no endless spinner); upload is refused up front when AI is not connected', async ({ page }) => {
  await wire(page);
  await page.goto(app.origin + '/');
  await page.getByText('Sign In', { exact: true }).first().click();
  await page.locator('#authEmail').fill(USER.email); await page.locator('#authPass').fill(USER.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#sidebar')).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1500);

  // 1. a document whose analysis failed
  await page.evaluate(() => {
    DB.documents.unshift({ id: 'errdoc1', name: 'Policy.docx', type: 'DOCX', size: '11 KB', country: 'United States', domain: 'Data Privacy', status: 'error', score: null, uploaded: '2026-10-29', gaps: [], errorMessage: 'Local AI is not connected. Start Ordinex on your computer.' });
    viewDocument('errdoc1');
  });
  const modal = await body(page);
  expect(modal).toContain('Analysis failed');
  expect(modal).toContain('Local AI is not connected');
  expect(modal).not.toMatch(/Analysis in progress/);

  // 2. hosted page, backend not connected: nothing is uploaded
  const before = await page.evaluate(() => DB.documents.length);
  await page.evaluate(() => {
    closeModal();
    localAIConfig.baseUrl = null;
    for (const [id, v] of [['uploadCountry', 'United States'], ['uploadDomain', 'Data Privacy']]) {
      const s = document.createElement('select'); s.id = id; s.innerHTML = `<option value="${v}">${v}</option>`; s.value = v; document.body.appendChild(s);
    }
    return handleUpload([new File(['hello world, this is a policy document'], 'a.txt', { type: 'text/plain' })]);
  });
  await expect(page.locator('body')).toContainText('AI analysis is not set up', { timeout: 5000 });
  expect(await page.evaluate(() => DB.documents.length)).toBe(before);
});

const FAKE_KEY = 'AQ.' + 'x'.repeat(40);        // newer Google key shape; AIza-style keys use the same code path
test('own free Gemini key: setup modal stores it locally, upload is analysed directly via Gemini with the key in a header, UI discloses Google', async ({ page }) => {
  const g = await wire(page);
  const calls = [];
  await page.route('**/generativelanguage.googleapis.com/**', async (route) => {
    const req = route.request(); const cors = { 'access-control-allow-origin': app.origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ url: req.url(), key: req.headers()['x-goog-api-key'] || '', body: req.postData() || '' });
    const text = JSON.stringify({ domain: 'Data Privacy', score: 62, gaps: [{ title: 'No retention period', severity: 'High', description: 'Retention is not stated.', recommendation: 'State a retention period.' }] });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) });
  });
  await page.goto(app.origin + '/');
  await page.getByText('Sign In', { exact: true }).first().click();
  await page.locator('#authEmail').fill(USER.email); await page.locator('#authPass').fill(USER.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#sidebar')).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1500);

  await page.evaluate(() => { localStorage.removeItem('ordinex.userGeminiKey'); localAIConfig.baseUrl = null; });   // as on the hosted site
  await page.locator('#local-ai-badge').click();                                       // nothing set up: badge opens the setup dialog
  await expect(page.locator('body')).toContainText('Set up AI analysis');
  await page.locator('#userGeminiKeyInput').fill('has spaces in it, not a key');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.locator('body')).toContainText('does not look like a Gemini API key');
  await page.locator('#userGeminiKeyInput').fill(FAKE_KEY);
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.locator('#local-ai-badge')).toContainText('your own Gemini key');
  expect(await page.evaluate(() => localStorage.getItem('ordinex.userGeminiKey'))).toBe(FAKE_KEY);

  await page.evaluate(() => {
    for (const [id, v] of [['uploadCountry', 'United States'], ['uploadDomain', 'Data Privacy']]) { const s = document.createElement('select'); s.id = id; s.innerHTML = `<option value="${v}">${v}</option>`; s.value = v; document.body.appendChild(s); }
    return handleUpload([new File(['Our privacy policy. We collect names and emails and keep them as long as we like. We share data with partners.'], 'policy.txt', { type: 'text/plain' })]);
  });
  await expect.poll(() => calls.filter((c) => c.url.includes(':generateContent')).length, { timeout: 15000 }).toBeGreaterThan(0);
  const gen = calls.find((c) => c.url.includes(':generateContent'));
  expect(gen.key).toBe(FAKE_KEY);                                  // key travels in a header...
  expect(gen.url).not.toContain(FAKE_KEY);                         // ...never in the URL
  expect(gen.body).toContain('privacy policy');
  await expect.poll(async () => page.evaluate(() => (DB.documents.find((d) => d.name === 'policy.txt') || {}).status), { timeout: 15000 }).toBe('analyzed');
  expect(await page.evaluate(() => DB.documents.find((d) => d.name === 'policy.txt').gaps.length)).toBeGreaterThan(0);

  // the key is never written to Firestore
  const dump = JSON.stringify(await (await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/users?pageSize=100`, { headers: { Authorization: 'Bearer owner' } })).json());
  expect(dump).not.toContain(FAKE_KEY);

  await page.locator('.sb-item', { hasText: 'Security & Audit' }).first().click();
  await expect(page.locator('body')).toContainText('document text is sent to Google Gemini under your own account');
  expect(g.prodHits.filter((h) => !/generativelanguage/.test(h))).toEqual([]);
});
