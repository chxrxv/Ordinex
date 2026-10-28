'use strict';
// public/firestore-rest.js against the REAL rules (Firestore + Auth emulators, fake demo project): malformed, forged,
// unverified, piggy-backed and concurrent commits. No browser needed; no real project is addressed.
const { test, expect } = require('@playwright/test');
const rest = require('../../public/firestore-rest.js');

const PROJECT = 'demo-ordinex';
const AUTH = 'http://127.0.0.1:9099', FS = 'http://127.0.0.1:8081';
const DOCS = `${FS}/v1/projects/${PROJECT}/databases/(default)/documents`;
const OWNER = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const S = (v) => ({ stringValue: v }), N = { nullValue: null };

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
});

async function authRest(path, body) {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/${path}?key=fake-api-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function ownerPut(path, fields) {
  const r = await fetch(`${DOCS}/${path}`, { method: 'PATCH', headers: OWNER, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error('owner write failed: ' + (await r.text()));
}
async function ownerGet(path) {
  const r = await fetch(`${DOCS}/${path}`, { headers: OWNER });
  if (r.status === 404) return null;
  const j = await r.json();
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, v.stringValue ?? v.integerValue ?? (v.nullValue === null ? null : v.timestampValue)]));
}
async function newUser(email, { verified = false } = {}) {
  const su = await authRest('accounts:signUp', { email, password: 'pw-123456', returnSecureToken: true });
  if (verified) {
    const codes = await (await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`)).json();
    await authRest('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: su.idToken });
    const after = await (await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`)).json();
    const code = after.oobCodes.filter((c) => c.email === email && c.requestType === 'VERIFY_EMAIL').pop();
    expect(code && code.oobLink, 'verification link exists').toBeTruthy();
    void codes;
    await fetch(code.oobLink);
  }
  const si = await authRest('accounts:signInWithPassword', { email, password: 'pw-123456', returnSecureToken: true });
  await ownerPut(`users/${si.localId}`, { uid: S(si.localId), email: S(email), role: N, organizationId: N });
  return { uid: si.localId, token: si.idToken, email };
}
const commit = (token, writes) => rest.commit({ projectId: PROJECT, idToken: token, baseUrl: FS, writes });
const pair = (orgId, email, uid, role = 'analyst') => [
  { path: `invitations/${orgId}_${email}`, fields: { status: 'accepted', acceptedBy: uid }, serverTimestamps: ['acceptedAt'] },
  { path: `users/${uid}`, fields: { organizationId: orgId, role } }];
async function seedOrg() {
  const org = 'OrgAbc123';
  await ownerPut(`organizations/${org}`, { name: S('Org'), plan: S('starter'), seats: { integerValue: '5' }, createdBy: S('someone') });
  return org;
}
const future = () => new Date(Date.now() + 7 * 864e5).toISOString();
async function seedInvite(org, email, role = 'analyst') {
  await ownerPut(`invitations/${org}_${email}`, { email: S(email), organizationId: S(org), organizationName: S('Org'), role: S(role), invitedBy: S('someone'), status: S('pending'), createdAt: { timestampValue: new Date().toISOString() }, expiresAt: { timestampValue: future() } });
}

test('unverified token cannot accept; after email verification and token refresh the same commit succeeds', async () => {
  const org = await seedOrg();
  const u = await newUser('squatter@x.test', { verified: false });
  await seedInvite(org, u.email);
  await expect(commit(u.token, pair(org, u.email, u.uid))).rejects.toMatchObject({ code: 'permission-denied' });
  expect((await ownerGet(`users/${u.uid}`)).organizationId).toBeNull();
  // verify, refresh the token (the app does getIdToken(true)), retry
  const codes = await (await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`)).json();
  await authRest('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: u.token });
  const after = await (await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`)).json();
  await fetch(after.oobCodes.filter((c) => c.email === u.email && c.requestType === 'VERIFY_EMAIL').pop().oobLink); void codes;
  const fresh = await authRest('accounts:signInWithPassword', { email: u.email, password: 'pw-123456', returnSecureToken: true });
  await expect(commit(fresh.idToken, pair(org, u.email, u.uid))).resolves.toBeTruthy();
  expect(await ownerGet(`users/${u.uid}`)).toMatchObject({ organizationId: org, role: 'analyst' });
});

test('forged commits are refused: upsert of a self-made invitation, forged timestamp, piggy-backed third write, wrong role', async () => {
  const org = await seedOrg();
  const victim = await newUser('victim@x.test', { verified: true });
  await ownerPut(`users/${victim.uid}`, { uid: S(victim.uid), email: S(victim.email), role: S('admin'), organizationId: S(org) });
  const e = await newUser('forger@x.test', { verified: true });

  // 1. invitee fabricates an invitation for themselves (upsert, mustExist:false) - no admin involved
  await expect(commit(e.token, [{ path: `invitations/${org}_${e.email}`, mustExist: false, fields: { email: e.email, organizationId: org, organizationName: 'Org', role: 'admin', invitedBy: e.uid, status: 'pending', expiresAt: new Date(Date.now() + 864e5) }, serverTimestamps: ['createdAt'] }])).rejects.toMatchObject({ code: 'permission-denied' });

  await seedInvite(org, e.email, 'analyst');
  // 2. forged acceptedAt (plain timestamp instead of the server transform)
  await expect(commit(e.token, [{ path: `invitations/${org}_${e.email}`, fields: { status: 'accepted', acceptedBy: e.uid, acceptedAt: new Date(Date.now() - 1000) } }, pair(org, e.email, e.uid)[1]])).rejects.toMatchObject({ code: 'permission-denied' });
  // 3. a third write piggy-backed onto a valid pair: demote the admin of the org
  await expect(commit(e.token, [...pair(org, e.email, e.uid), { path: `users/${victim.uid}`, fields: { role: 'user' } }])).rejects.toMatchObject({ code: 'permission-denied' });
  // 4. role differs from the invitation
  await expect(commit(e.token, pair(org, e.email, e.uid, 'admin'))).rejects.toMatchObject({ code: 'permission-denied' });
  // none of the failed attempts changed anything
  expect((await ownerGet(`users/${e.uid}`)).organizationId).toBeNull();
  expect((await ownerGet(`users/${victim.uid}`)).role).toBe('admin');
  expect((await ownerGet(`invitations/${org}_${e.email}`)).status).toBe('pending');
});

test('malformed REST payloads are rejected before or by the server (no silent success)', async () => {
  const u = await newUser('malformed@x.test', { verified: true });
  await expect(commit(u.token, [{ path: 'users', fields: {} }])).rejects.toThrow(/Invalid document path/);
  await expect(commit(u.token, [{ path: `users/${u.uid}`, fields: { role: { nested: 1 } } }])).rejects.toThrow(/Unsupported/);
  await expect(commit(u.token, [])).rejects.toThrow(/At least one/);
  await expect(rest.commit({ projectId: PROJECT, baseUrl: FS, writes: [{ path: `users/${u.uid}`, fields: {} }] })).rejects.toThrow(/signed-in user/);
  await expect(commit('not-a-real-token', [{ path: `users/${u.uid}`, fields: { displayName: 'x' } }])).rejects.toBeTruthy();
  // an update to a document that does not exist must not create it
  await expect(commit(u.token, [{ path: 'users/nonexistentuser', fields: { displayName: 'x' } }])).rejects.toBeTruthy();
  expect(await ownerGet('users/nonexistentuser')).toBeNull();
});

test('CONCURRENT acceptance over REST: exactly one of many parallel commits succeeds, one membership results', async () => {
  const org = await seedOrg();
  const u = await newUser('racer@x.test', { verified: true });
  await seedInvite(org, u.email);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => commit(u.token, pair(org, u.email, u.uid))));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await ownerGet(`users/${u.uid}`)).toMatchObject({ organizationId: org, role: 'analyst' });
  expect((await ownerGet(`invitations/${org}_${u.email}`)).status).toBe('accepted');
});
