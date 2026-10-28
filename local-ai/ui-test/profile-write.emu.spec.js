'use strict';
// REGRESSION: signing up must write the user profile ONCE.
// Bug: ensureUserProfile() ran twice concurrently (doAuth + the onAuthStateChanged safety net). Both saw "no profile yet"
// and both wrote; the second write is an UPDATE that rewrites createdAt, which firestore.rules (profile allow-list)
// correctly refuses -> "Could not create user profile: PERMISSION_DENIED" on every sign-up.
// The rules must stay strict; the client must not produce the duplicate write. Emulators only (fake demo-ordinex project).
const { test, expect } = require('@playwright/test');
const { startConfiguredApp } = require('./helpers/env');

const PROJECT = 'demo-ordinex';
const AUTH = 'http://127.0.0.1:9099', FS = 'http://127.0.0.1:8081';
const USER = { email: 'profile-once@acme.test', password: 'correct-horse-9', org: 'Profile Once Co' };

let app;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  app = await startConfiguredApp(8853);
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
});
test.afterAll(async () => { await app.close(); });

async function wire(page) {
  const errors = [], prodHits = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
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
  return { errors, prodHits };
}
const profileErrors = (errs) => errs.filter((e) => /Could not create user profile|PERMISSION_DENIED|insufficient permissions/i.test(e));
async function ownerUser(email) {
  const j = await (await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/users?pageSize=100`, { headers: { Authorization: 'Bearer owner' } })).json();
  const d = (j.documents || []).find((x) => x.fields.email && x.fields.email.stringValue === email);
  return d ? Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, v.stringValue ?? (v.nullValue === null ? null : v.timestampValue ? '<timestamp>' : '<other>')])) : null;
}

test('email sign-up writes the profile exactly once: no denied duplicate write, profile + org end up correct', async ({ page }) => {
  const g = await wire(page);
  await page.goto(app.origin + '/');
  await page.getByRole('button', { name: /Start Free (Trial|Analysis)/ }).first().click();
  await page.locator('#authOrg').fill(USER.org); await page.locator('#authEmail').fill(USER.email); await page.locator('#authPass').fill(USER.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('#sidebar')).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(2500);                                   // let any second (duplicate) write settle and fail
  expect(profileErrors(g.errors), 'a duplicate profile write was attempted and refused').toEqual([]);
  const p = await ownerUser(USER.email);
  expect(p).toMatchObject({ email: USER.email, role: 'admin' });
  expect(p.organizationId).toBeTruthy();
  expect(p.createdAt).toBe('<timestamp>');
  expect(g.prodHits).toEqual([]);
});

test('signing in again does not rewrite the profile or raise permission errors', async ({ page }) => {
  const g = await wire(page);
  const before = await ownerUser(USER.email);
  await page.goto(app.origin + '/');
  await page.getByText('Sign In', { exact: true }).first().click();
  await page.locator('#authEmail').fill(USER.email); await page.locator('#authPass').fill(USER.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#sidebar')).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1500);
  expect(profileErrors(g.errors)).toEqual([]);
  expect(await ownerUser(USER.email)).toEqual(before);
});
