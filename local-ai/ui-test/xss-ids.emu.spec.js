'use strict';
// AUDIT: stored XSS through attacker-chosen Firestore document IDs embedded in inline onclick handlers.
// A low-privilege MEMBER writes a document whose ID is a JavaScript payload; an ADMIN then uses the Documents page.
// Emulators only (fake demo-ordinex project). The test asserts the SECURE outcome (payload never runs).
const { test, expect } = require('@playwright/test');
const { startConfiguredApp } = require('./helpers/env');

const PROJECT = 'demo-ordinex';
const AUTH = 'http://127.0.0.1:9099', FS = 'http://127.0.0.1:8081';
const ADMIN = { email: 'xss-admin@acme.test', password: 'correct-horse-9', org: 'Acme XSS' };
const MEMBER = { email: 'xss-member@acme.test', password: 'battery-staple-7' };
const PAYLOADS = [
  "x');window.__xss=1;//",                 // breaks out of a single-quoted JS string
  "x\\');window.__xss=1;//",               // backslash variant
  "x');window.__xss=1;('",                 // balanced variant
];

let app;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  app = await startConfiguredApp(8852);
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
});
test.afterAll(async () => { await app.close(); });

const bearer = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });
async function authRest(path, body) {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/${path}?key=fake-api-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
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
    if (/(googleapis|gstatic|firebaseio|firebaseapp|google)\.com$/.test(h)) { prodHits.push(u.origin); return route.abort(); }
    return route.continue();
  });
  return { prodHits };
}

test('stored XSS via attacker-chosen document IDs: a member cannot make an admin run script', async ({ page }) => {
  const g = await wire(page);
  // 1. Admin signs up through the real UI and gets an organisation.
  await page.goto(app.origin + '/');
  await page.getByRole('button', { name: /Start Free (Trial|Analysis)/ }).first().click();
  await page.locator('#authOrg').fill(ADMIN.org); await page.locator('#authEmail').fill(ADMIN.email); await page.locator('#authPass').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('#sidebar')).toBeVisible({ timeout: 30000 });
  const list = await (await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/users?pageSize=50`, { headers: { Authorization: 'Bearer owner' } })).json();
  const adminDoc = list.documents.find((d) => d.fields.email.stringValue === ADMIN.email);
  const orgId = adminDoc.fields.organizationId.stringValue;

  // 2. A low-privilege member exists in that org (membership set up as the emulator owner, standing in for an accepted invitation).
  const su = await authRest('accounts:signUp', { email: MEMBER.email, password: MEMBER.password, returnSecureToken: true });
  await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/users/${su.localId}`, { method: 'PATCH', headers: bearer('owner'), body: JSON.stringify({ fields: { uid: { stringValue: su.localId }, email: { stringValue: MEMBER.email }, role: { stringValue: 'user' }, organizationId: { stringValue: orgId } } }) });
  const mem = await authRest('accounts:signInWithPassword', { email: MEMBER.email, password: MEMBER.password, returnSecureToken: true });

  // 3. The member plants documents whose IDs are script payloads, using ONLY their own token (rules decide).
  const planted = [];
  for (const id of PAYLOADS) {
    const r = await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/documents?documentId=${encodeURIComponent(id)}`, { method: 'POST', headers: bearer(mem.idToken), body: JSON.stringify({ fields: { organizationId: { stringValue: orgId }, uploadedBy: { stringValue: su.localId }, name: { stringValue: 'harmless.pdf' }, status: { stringValue: 'analyzed' }, uploadedAt: { timestampValue: new Date().toISOString() }, size: { stringValue: '1 KB' }, contentType: { stringValue: 'application/pdf' }, country: { stringValue: 'India' } } }) });
    planted.push({ id, status: r.status });
  }
  console.log('[audit] planted payload document statuses:', planted.map((p) => p.status).join(','));

  // 4. The admin uses the Documents page normally (clicks every document action that carries an ID).
  await page.locator('.sb-item', { hasText: 'Documents' }).first().click();
  await page.waitForTimeout(1500);
  const sinks = page.locator('[onclick*="viewDocument"], [onclick*="confirmDeleteDocument"], [onclick*="downloadDocumentPdf"]');
  const count = await sinks.count();
  console.log('[audit] clickable document actions rendered for admin:', count);
  for (let i = 0; i < count; i++) { try { await sinks.nth(i).click({ timeout: 2000, force: true }); } catch { /* modal may block; continue */ } try { await page.keyboard.press('Escape'); } catch { /* ignore */ } }
  const ran = await page.evaluate(() => window.__xss);

  expect(ran, 'attacker-controlled document ID executed as script in the admin session').toBeUndefined();
  expect(g.prodHits).toEqual([]);
});

test('defence in depth: a malicious id ALREADY in the database (legacy data, rules bypassed) still cannot run script in the admin UI', async ({ page }) => {
  const g = await wire(page);
  await page.goto(app.origin + '/');
  await page.getByText('Sign In', { exact: true }).first().click();
  await page.locator('#authEmail').fill(ADMIN.email); await page.locator('#authPass').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#sidebar')).toBeVisible({ timeout: 30000 });
  const list = await (await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/users?pageSize=50`, { headers: { Authorization: 'Bearer owner' } })).json();
  const orgId = list.documents.find((d) => d.fields.email.stringValue === ADMIN.email).fields.organizationId.stringValue;
  // inject as the emulator OWNER (bypasses rules) - simulates data written before the new rules existed
  for (const id of PAYLOADS.filter((p) => !p.includes('/') && !p.includes(String.fromCharCode(92)))) {   // Firestore itself refuses ids containing / or a backslash
    const r = await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/documents?documentId=${encodeURIComponent(id)}`, { method: 'POST', headers: bearer('owner'), body: JSON.stringify({ fields: { organizationId: { stringValue: orgId }, uploadedBy: { stringValue: 'legacy' }, name: { stringValue: 'legacy.pdf' }, status: { stringValue: 'analyzed' }, uploadedAt: { timestampValue: new Date().toISOString() }, size: { stringValue: '1 KB' }, contentType: { stringValue: 'application/pdf' }, country: { stringValue: 'India' } } }) });
    expect(r.ok).toBe(true);
  }
  await page.locator('.sb-item', { hasText: 'Documents' }).first().click();
  await page.waitForTimeout(1500);
  const sinks = page.locator('[onclick*="viewDocument"], [onclick*="confirmDeleteDocument"], [onclick*="downloadDocumentPdf"]');
  const count = await sinks.count();
  expect(count, 'the legacy malicious-id documents are rendered, so the sink is genuinely exercised').toBeGreaterThan(0);
  for (let i = 0; i < count; i++) { try { await sinks.nth(i).click({ timeout: 2000, force: true }); } catch { /* ignore */ } try { await page.keyboard.press('Escape'); } catch { /* ignore */ } }
  expect(await page.evaluate(() => window.__xss), 'script from a document id ran').toBeUndefined();
  expect(g.prodHits).toEqual([]);
});
