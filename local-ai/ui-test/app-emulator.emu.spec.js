'use strict';
// The REAL signed-in Ordinex app, in a real browser, against the Firebase Auth + Firestore EMULATORS.
//  - The app is served with a FAKE config (project "demo-ordinex"); the real project is never addressed.
//  - Emulator hosts are injected through the SDK's own __FIREBASE_DEFAULTS__ hook (test-only; no production change).
//  - The two REST calls the app makes to Google API hosts are proxied to the emulators; ANY other request to a
//    real Google/Firebase host is aborted and fails the test.
//  - The project's real firestore.rules are loaded by the emulator.
// Run: npm run ai:ui:test:emulator
const { test, expect } = require('@playwright/test');
const { startConfiguredApp } = require('./helpers/env');
const rest = require('../../public/firestore-rest.js');

const PROJECT = 'demo-ordinex';
const AUTH = 'http://127.0.0.1:9099', FS = 'http://127.0.0.1:8081';
const ADMIN = { email: 'admin@acme.test', password: 'correct-horse-9', org: 'Acme Corp' };
const INVITEE = { email: 'invitee@acme.test', password: 'battery-staple-7' };

let app;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  app = await startConfiguredApp(8851);
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
});
test.afterAll(async () => { await app.close(); });

// -------- helpers: read as the emulator "owner" (bypasses rules, used only to VERIFY state) -------------------------
const val = (v) => (v == null ? undefined : 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'nullValue' in v ? null : 'timestampValue' in v ? v.timestampValue : v);
async function ownerGet(p) {
  const r = await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/${p}`, { headers: { Authorization: 'Bearer owner' } });
  if (r.status === 404) return null;
  const j = await r.json();
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, val(v)]));
}
async function ownerList(col) {
  const r = await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/${col}?pageSize=100`, { headers: { Authorization: 'Bearer owner' } });
  const j = await r.json();
  return (j.documents || []).map((d) => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, val(v)])) }));
}
async function signIn({ email, password }) {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  return r.json();                                   // { idToken, localId, ... }
}
async function verifyEmailViaEmulator(email) {
  let code;
  await expect.poll(async () => {                    // the app sends the verification request asynchronously after sign-up
    const j = await (await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`)).json();
    code = j.oobCodes.filter((c) => c.email === email && c.requestType === 'VERIFY_EMAIL').pop();
    return !!code;
  }, { message: 'a verification email was requested for ' + email, timeout: 15000 }).toBe(true);
  const r = await fetch(code.oobLink);                // what clicking the emailed link does
  expect(r.ok).toBe(true);
}

/** Wires a page to the emulators and records any attempt to reach a real Google/Firebase host. */
async function wire(page) {
  const prodHits = [], proxied = [];
  await page.addInitScript(() => { window.__FIREBASE_DEFAULTS__ = { emulatorHosts: { auth: '127.0.0.1:9099', firestore: '127.0.0.1:8081' } }; });
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    const h = u.hostname;
    if (h === '127.0.0.1' || h === 'localhost') return route.continue();
    if (h === 'identitytoolkit.googleapis.com' || h === 'securetoken.googleapis.com' || h === 'firestore.googleapis.com') {
      proxied.push(h + u.pathname);
      const target = (h === 'firestore.googleapis.com' ? FS : `${AUTH}/${h}`) + u.pathname + u.search;
      const cors = { 'access-control-allow-origin': app.origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const resp = await route.fetch({ url: target });
      return route.fulfill({ response: resp, headers: { ...resp.headers(), ...cors } });
    }
    if (h === 'fonts.googleapis.com' || h === 'fonts.gstatic.com') return route.continue();   // static web fonts, not an API
    if (/(googleapis|gstatic|firebaseio|firebaseapp|google)\.com$/.test(h)) { prodHits.push(u.origin + u.pathname); return route.abort(); }
    return route.continue();                          // fonts, etc.
  });
  return { prodHits, proxied };
}
const openApp = async (page) => { await page.goto(app.origin + '/'); await expect(page.getByText(/Navigate Global Compliance/)).toBeVisible(); };
async function login(page, { email, password }) {
  await page.getByText('Sign In', { exact: true }).first().click();
  await expect(page.locator('#authEmail')).toBeVisible();
  await page.locator('#authEmail').fill(email); await page.locator('#authPass').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function register(page, { email, password, org }) {
  await page.getByRole('button', { name: /Start Free (Trial|Analysis)/ }).first().click();
  await expect(page.locator('#authEmail')).toBeVisible();
  if (org) await page.locator('#authOrg').fill(org);
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPass').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
}

test('SIGN-UP + ORGANISATION: a real registration creates the profile, a starter org, and lands in the app', async ({ page }) => {
  const g = await wire(page);
  await openApp(page);
  await register(page, ADMIN);
  await expect(page.locator('#sidebar')).toBeVisible({ timeout: 30000 });
  const users = await ownerList('users');
  const me = users.find((u) => u.email === ADMIN.email);
  expect(me, 'profile document created').toBeTruthy();
  expect(me.role).toBe('admin');
  const org = await ownerGet('organizations/' + me.organizationId);
  expect(org).toMatchObject({ name: ADMIN.org, plan: 'starter', seats: 5, createdBy: me.uid });
  expect(g.proxied.some((x) => x.includes('sendOobCode'))).toBe(true);        // verification email requested
  expect(g.prodHits).toEqual([]);
});

test('INVITE (admin UI): Team page -> Invite Member writes an organisation-scoped invitation', async ({ page }) => {
  const g = await wire(page);
  await openApp(page);
  await login(page, ADMIN);
  await expect(page.locator('#sidebar')).toBeVisible({ timeout: 30000 });
  await page.locator('.sb-item', { hasText: 'Team' }).first().click();
  await page.getByRole('button', { name: /Invite Member/ }).click();
  await page.locator('#inviteEmail').fill('Invitee@Acme.test');                  // mixed case on purpose: stored lower-cased
  await page.locator('#inviteRole').selectOption('Analyst');
  await page.getByRole('button', { name: /Send Invite/ }).click();
  await expect(page.getByText(/Invitation (created|emailed)/)).toBeVisible({ timeout: 15000 });
  const me = (await ownerList('users')).find((u) => u.email === ADMIN.email);
  const invs = await ownerList('invitations');
  expect(invs).toHaveLength(1);
  expect(invs[0].id).toBe(`${me.organizationId}_${INVITEE.email}`);
  expect(invs[0]).toMatchObject({ email: INVITEE.email, organizationId: me.organizationId, role: 'analyst', status: 'pending', organizationName: ADMIN.org });
  expect(g.prodHits).toEqual([]);
});

test('INVITE (invitee UI): register without an org, verify email, accept -> joins exactly that org and role, atomically', async ({ page }) => {
  const g = await wire(page);
  await openApp(page);
  await register(page, { ...INVITEE });                                   // organisation name left empty
  await expect(page.getByText("You've been invited")).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(ADMIN.org).first()).toBeVisible();
  // Unverified: accepting is not offered, and the server would refuse it anyway.
  await expect(page.getByRole('button', { name: /Accept invitation/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: "I've verified my email" })).toBeVisible();
  await page.getByRole('button', { name: "I've verified my email" }).click();           // not verified yet
  await expect(page.getByRole('button', { name: /Accept invitation/ })).toHaveCount(0);
  await verifyEmailViaEmulator(INVITEE.email);                                           // the invitee clicks the emailed link
  await page.getByRole('button', { name: "I've verified my email" }).click();
  await expect(page.getByRole('button', { name: /Accept invitation to Acme Corp/ })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /Accept invitation to Acme Corp/ }).click();
  await expect(page.locator('#sidebar')).toBeVisible({ timeout: 30000 });
  const admin = (await ownerList('users')).find((u) => u.email === ADMIN.email);
  const me = (await ownerList('users')).find((u) => u.email === INVITEE.email);
  expect(me).toMatchObject({ organizationId: admin.organizationId, role: 'analyst' });
  const inv = await ownerGet(`invitations/${admin.organizationId}_${INVITEE.email}`);
  expect(inv.status).toBe('accepted'); expect(inv.acceptedBy).toBe(me.uid);
  expect(g.proxied.some((x) => x.includes('documents:commit'))).toBe(true);              // the atomic REST commit was used
  expect(g.prodHits).toEqual([]);
});

test('STALE REJOIN (real backend rules): after removal, the consumed invitation cannot be replayed via the REST commit', async () => {
  const admin = (await ownerList('users')).find((u) => u.email === ADMIN.email);
  const inviteeUser = (await ownerList('users')).find((u) => u.email === INVITEE.email);
  // The admin removes the member exactly like removeMember() does (owner write stands in for the admin's UI click).
  await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/users/${inviteeUser.uid}?updateMask.fieldPaths=organizationId&updateMask.fieldPaths=role`, { method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { organizationId: { nullValue: null }, role: { nullValue: null } } }) });
  const s = await signIn(INVITEE);
  const replay = () => rest.commit({ projectId: PROJECT, idToken: s.idToken, baseUrl: FS, writes: [
    { path: `invitations/${admin.organizationId}_${INVITEE.email}`, fields: { status: 'accepted', acceptedBy: s.localId }, serverTimestamps: ['acceptedAt'] },
    { path: `users/${s.localId}`, fields: { organizationId: admin.organizationId, role: 'analyst' } }] });
  await expect(replay()).rejects.toMatchObject({ code: 'permission-denied' });
  const half = () => rest.commit({ projectId: PROJECT, idToken: s.idToken, baseUrl: FS, writes: [
    { path: `users/${s.localId}`, fields: { organizationId: admin.organizationId, role: 'analyst' } }] });
  await expect(half()).rejects.toMatchObject({ code: 'permission-denied' });         // join alone
  expect((await ownerGet('users/' + s.localId)).organizationId).toBeNull();
});

test('STALE REJOIN (UI): the removed member sees onboarding with NO invitation to reuse', async ({ page }) => {
  const g = await wire(page);
  await openApp(page);
  await login(page, INVITEE);
  await expect(page.getByText('Name your organization')).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("You've been invited")).toHaveCount(0);
  expect(g.prodHits).toEqual([]);
});

test('BILLING (UI + rules): an org admin sees no plan buttons and cannot write plan/seats even with their own token', async ({ page }) => {
  const g = await wire(page);
  await openApp(page);
  await login(page, ADMIN);
  await expect(page.locator('#sidebar')).toBeVisible({ timeout: 30000 });
  await page.evaluate(() => { openUpgradePlanModal(); });
  await expect(page.getByText(/can only be changed by the platform administrator/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select' })).toHaveCount(0);
  const admin = (await ownerList('users')).find((u) => u.email === ADMIN.email);
  const s = await signIn(ADMIN);
  const patch = (fields) => fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/organizations/${admin.organizationId}?${Object.keys(fields).map((k) => 'updateMask.fieldPaths=' + k).join('&')}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + s.idToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v }])) }) });
  expect((await patch({ plan: 'enterprise' })).status).toBe(403);
  expect((await patch({ seats: 1000 })).status).toBe(403);
  expect((await patch({ name: 'Acme Renamed' })).status).toBe(200);                         // rename is allowed
  expect((await ownerGet('organizations/' + admin.organizationId))).toMatchObject({ plan: 'starter', seats: 5, name: 'Acme Renamed' });
  expect(g.prodHits).toEqual([]);
});

test('SHARED REGULATIONS (UI + rules): the Sync button is hidden for an org admin and the write is refused', async ({ page }) => {
  const g = await wire(page);
  await openApp(page);
  await login(page, ADMIN);
  await expect(page.locator('#sidebar')).toBeVisible({ timeout: 30000 });
  await page.locator('.sb-item', { hasText: 'Knowledge Base' }).first().click();
  await expect(page.getByRole('heading', { name: /Regulation Knowledge Base/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Sync Regulation Database/ })).toHaveCount(0);
  const s = await signIn(ADMIN);
  const r = await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/regulations/reg_x?updateMask.fieldPaths=name`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + s.idToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { name: { stringValue: 'tampered' } } }) });
  expect(r.status).toBe(403);
  expect(g.prodHits).toEqual([]);
});

test('PLATFORM ADMIN (UI + rules): the trusted path works - Set plan in the Admin Console and Sync Regulation Database', async ({ page }) => {
  const g = await wire(page);
  const admin = (await ownerList('users')).find((u) => u.email === ADMIN.email);
  // Stand-in for the documented MANUAL console step (docs/PLATFORM_ADMIN.md): create platformAdmins/{uid}. Emulator only.
  const mk = await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/platformAdmins?documentId=${admin.uid}`, { method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { note: { stringValue: 'emulator test' } } }) });
  expect(mk.ok).toBe(true);
  await openApp(page);
  await login(page, ADMIN);
  await expect(page.locator('#sidebar')).toBeVisible({ timeout: 30000 });
  await page.locator('.sb-item', { hasText: 'Admin Console' }).first().click({ timeout: 20000 });
  const select = page.locator('select[aria-label^="Set plan for"]').first();
  await expect(select).toBeVisible({ timeout: 20000 });
  await select.selectOption('professional');
  await expect(page.getByText(/Set Professional plan \(25 seats\)/)).toBeVisible({ timeout: 15000 });
  expect(await ownerGet('organizations/' + admin.organizationId)).toMatchObject({ plan: 'professional', seats: 25 });
  await page.locator('.sb-item', { hasText: 'Knowledge Base' }).first().click();
  await page.getByRole('button', { name: /Sync Regulation Database/ }).click();
  await expect(page.getByText(/Synced 10 regulation/)).toBeVisible({ timeout: 20000 });
  expect((await ownerList('regulations')).length).toBe(10);
  expect(g.prodHits).toEqual([]);
});
