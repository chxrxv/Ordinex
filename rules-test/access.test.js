'use strict';
// Second rules suite: invitations (org-scoped ids, atomic accept+join), member management, billing fields,
// notifications, shared regulations, reserved fields, and sign-up / workflow regressions.
// Runs against the Firestore EMULATOR. Payloads mirror what public/ordinex.html writes. Atomic accept+join uses
// writeBatch here; the app sends the equivalent REST `documents:commit` (covered end to end by the UI suite).
const { test, before, after, beforeEach } = require('node:test');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, serverTimestamp, Timestamp, writeBatch } = require('firebase/firestore');
const fs = require('node:fs');
const path = require('node:path');

let env;
const [HOST, PORT] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8081').split(':');
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-ordinex-access', firestore: { host: HOST, port: Number(PORT), rules: fs.readFileSync(process.env.RULES_FILE || path.join(__dirname, '..', 'firestore.rules'), 'utf8') } });
});
after(async () => { await env.cleanup(); });

const inDays = (n) => Timestamp.fromMillis(Date.now() + n * 864e5);
const ago = (min) => Timestamp.fromMillis(Date.now() - min * 60000);
const EMAIL = { alice: 'alice@a.io', bob: 'bob@a.io', carol: 'carol@b.io', dave: 'dave@x.io', erin: 'erin@x.io', frank: 'frank@x.io', hank: 'hank@x.io' };
const inv = (org, email) => `${org}_${email}`;
const seedInvite = (org, email, over = {}) => ({ email, organizationId: org, organizationName: org === 'orgA' ? 'A' : 'B', role: 'analyst', invitedBy: org === 'orgA' ? 'alice' : 'carol', status: 'pending', createdAt: ago(5), expiresAt: inDays(7), ...over });
function assert2(cond, msg) { if (!cond) throw new Error('assertion failed: ' + msg); }

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const u = (uid, org, role) => setDoc(doc(db, 'users', uid), { uid, organizationId: org, role, email: EMAIL[uid] || null });
    await Promise.all([
      u('alice', 'orgA', 'admin'), u('bob', 'orgA', 'analyst'), u('carol', 'orgB', 'admin'), u('dave', null, null), u('erin', null, null), u('frank', null, null), u('hank', null, null), u('gina', 'orgB', 'user'),
      setDoc(doc(db, 'organizations', 'orgA'), { name: 'A', createdBy: 'alice', plan: 'starter', seats: 5 }),
      setDoc(doc(db, 'organizations', 'orgB'), { name: 'B', createdBy: 'carol', plan: 'starter', seats: 5 }),
      setDoc(doc(db, 'platformAdmins', 'root'), { x: 1 }), setDoc(doc(db, 'users', 'root'), { uid: 'root', organizationId: null, role: null }),
      setDoc(doc(db, 'regulations', 'reg1'), { name: 'GDPR', countryCode: 'EU' }),
      setDoc(doc(db, 'documents', 'docA'), { organizationId: 'orgA', uploadedBy: 'bob', uploadedAt: ago(60), status: 'analyzed', name: 'a.pdf' }),
      setDoc(doc(db, 'complianceReports', 'repA'), { organizationId: 'orgA', createdAt: ago(60), title: 't' }),
      setDoc(doc(db, 'riskAssessments', 'riskA'), { organizationId: 'orgA', createdAt: ago(60), score: 10 }),
      setDoc(doc(db, 'complianceIssues', 'issA'), { organizationId: 'orgA', documentId: 'docA', createdAt: ago(60), status: 'Open', severity: 'High' }),
      setDoc(doc(db, 'notifications', 'nBob'), { userId: 'bob', organizationId: 'orgA', read: false, title: 't' }),
      setDoc(doc(db, 'invitations', inv('orgA', EMAIL.erin)), seedInvite('orgA', EMAIL.erin)),                                                          // pending
      setDoc(doc(db, 'invitations', inv('orgA', EMAIL.frank)), seedInvite('orgA', EMAIL.frank, { role: 'user', createdAt: ago(60 * 24 * 20), expiresAt: Timestamp.fromMillis(Date.now() - 864e5) })),   // expired
      setDoc(doc(db, 'invitations', inv('orgA', EMAIL.hank)), seedInvite('orgA', EMAIL.hank, { status: 'accepted', acceptedBy: 'hank', acceptedAt: ago(5) })),                                   // consumed
    ]);
  });
});
const as = (uid, claims = {}) => env.authenticatedContext(uid, { email: EMAIL[uid], email_verified: true, ...claims }).firestore();
const unverified = (uid) => env.authenticatedContext(uid, { email: EMAIL[uid], email_verified: false }).firestore();
const newInvite = (over = {}) => ({ email: 'new@x.io', organizationId: 'orgA', organizationName: 'A', role: 'analyst', invitedBy: 'alice', status: 'pending', createdAt: serverTimestamp(), expiresAt: inDays(7), ...over });

/** Atomic accept + join: the pair of writes the app commits. Options let tests tamper with either half. */
function acceptAndJoin(db, uid, { org = 'orgA', email = EMAIL[uid], role = 'analyst', inviteDoc, invitePatch = {}, userPatch = {}, skipInvite = false, skipUser = false } = {}) {
  const b = writeBatch(db);
  if (!skipInvite) b.update(doc(db, 'invitations', inviteDoc || inv(org, email)), { status: 'accepted', acceptedBy: uid, acceptedAt: serverTimestamp(), ...invitePatch });
  if (!skipUser) b.update(doc(db, 'users', uid), { organizationId: org, role, ...userPatch });
  return b.commit();
}

// ------------------------------------------------------------------ regression: sign-up + org creation
test('REGRESSION sign-up -> create organization -> become admin -> use the workspace (exact app sequence)', async () => {
  const db = as('newbie');
  await assertSucceeds(setDoc(doc(db, 'users', 'newbie'), { uid: 'newbie', email: 'n@x.io', displayName: 'n', photoURL: null, role: null, organizationId: null, createdAt: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(db, 'organizations', 'orgN'), { name: 'N', plan: 'starter', seats: 5, createdBy: 'newbie', createdAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, 'users', 'newbie'), { organizationId: 'orgN', role: 'admin' }));
  await assertSucceeds(addDoc(collection(db, 'auditLogs'), { organizationId: 'orgN', actorUid: 'newbie', action: 'Organization created', target: 'N', status: 'success', timestamp: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(db, 'documents', 'dN'), { organizationId: 'orgN', uploadedBy: 'newbie', name: 'x.pdf', status: 'processing', uploadedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(db, 'documents', 'dN')));
  await assertFails(getDoc(doc(as('carol'), 'documents', 'dN')));
});
test('a signed-up user cannot adopt an org they did not create (bootstrap abuse) or set createdBy later', async () => {
  const db = as('dave');
  await assertFails(updateDoc(doc(db, 'users', 'dave'), { organizationId: 'orgB', role: 'admin' }));
  await assertSucceeds(setDoc(doc(db, 'organizations', 'orgD'), { name: 'D', createdBy: 'dave', plan: 'starter', seats: 5 }));
  await assertFails(updateDoc(doc(as('alice'), 'organizations', 'orgA'), { createdBy: 'dave' }));
});

// ------------------------------------------------------------------ billing integrity
test('BILLING: new organisations always start on starter/5 seats', async () => {
  const db = as('dave');
  await assertFails(setDoc(doc(db, 'organizations', 'o1'), { name: 'X', createdBy: 'dave', plan: 'enterprise', seats: 5 }));
  await assertFails(setDoc(doc(db, 'organizations', 'o2'), { name: 'X', createdBy: 'dave', plan: 'starter', seats: 100 }));
  await assertFails(setDoc(doc(db, 'organizations', 'o3'), { name: 'X', createdBy: 'dave' }));
  await assertSucceeds(setDoc(doc(db, 'organizations', 'o4'), { name: 'X', createdBy: 'dave', plan: 'starter', seats: 5, createdAt: serverTimestamp() }));
});
test('BILLING: org admins and members cannot change plan or seats; admins may only rename', async () => {
  const a = as('alice'), b = as('bob'), c = as('carol');
  for (const patch of [{ plan: 'enterprise' }, { seats: 1000 }, { plan: 'professional', seats: 25 }, { name: 'A2', plan: 'enterprise' }, { createdBy: 'dave' }, { owner: 'x' }]) {
    await assertFails(updateDoc(doc(a, 'organizations', 'orgA'), patch));
    await assertFails(updateDoc(doc(b, 'organizations', 'orgA'), patch));
    await assertFails(updateDoc(doc(c, 'organizations', 'orgA'), patch));
  }
  await assertFails(updateDoc(doc(a, 'organizations', 'orgA'), { name: '' }));
  await assertFails(updateDoc(doc(a, 'organizations', 'orgA'), { name: 'x'.repeat(121) }));
  await assertFails(updateDoc(doc(a, 'organizations', 'orgA'), { name: 5 }));
  await assertFails(updateDoc(doc(a, 'organizations', 'orgB'), { name: 'hijack' }));
  await assertSucceeds(updateDoc(doc(a, 'organizations', 'orgA'), { name: 'Renamed' }));
  await assertFails(deleteDoc(doc(a, 'organizations', 'orgA')));
});
test('BILLING: only a platform admin can set plan/seats (valid values only), on any org', async () => {
  const root = as('root');
  await assertSucceeds(updateDoc(doc(root, 'organizations', 'orgA'), { plan: 'professional', seats: 25 }));
  await assertSucceeds(updateDoc(doc(root, 'organizations', 'orgB'), { plan: 'enterprise', seats: 100 }));
  for (const bad of [{ plan: 'free', seats: 5 }, { plan: 'professional', seats: 0 }, { plan: 'professional', seats: -3 }, { plan: 'professional', seats: 1001 }, { plan: 'professional', seats: 2.5 }, { plan: 'professional', seats: '25' }, { plan: 'professional', seats: 25, name: 'x' }, { createdBy: 'root' }]) {
    await assertFails(updateDoc(doc(root, 'organizations', 'orgA'), bad));
  }
  await assertFails(updateDoc(doc(env.unauthenticatedContext().firestore(), 'organizations', 'orgA'), { plan: 'enterprise', seats: 100 }));
  await assertFails(setDoc(doc(as('alice'), 'platformAdmins', 'alice'), { x: 1 }));
});

// ------------------------------------------------------------------ invitations: creation + org isolation
test('invitation create: org admin only, id embeds the org, correct email/role/expiry/shape', async () => {
  const id = inv('orgA', 'new@x.io');
  await assertSucceeds(setDoc(doc(as('alice'), 'invitations', id), newInvite()));
  await assertSucceeds(setDoc(doc(as('alice'), 'invitations', inv('orgA', 'date@x.io')), newInvite({ email: 'date@x.io', expiresAt: new Date(Date.now() + 14 * 864e5) })));
  await assertFails(setDoc(doc(as('bob'), 'invitations', id), newInvite({ invitedBy: 'bob' })));
  await assertFails(setDoc(doc(as('alice'), 'invitations', 'new@x.io'), newInvite()));
  await assertFails(setDoc(doc(as('alice'), 'invitations', inv('orgA', 'other@x.io')), newInvite()));
  await assertFails(setDoc(doc(as('alice'), 'invitations', inv('orgA', 'New@x.io')), newInvite({ email: 'New@x.io' })));
  await assertFails(setDoc(doc(as('alice'), 'invitations', id), newInvite({ role: 'superuser' })));
  await assertFails(setDoc(doc(as('alice'), 'invitations', id), newInvite({ status: 'accepted' })));
  await assertFails(setDoc(doc(as('alice'), 'invitations', id), newInvite({ invitedBy: 'carol' })));
  await assertFails(setDoc(doc(as('alice'), 'invitations', id), newInvite({ expiresAt: inDays(60) })));
  await assertFails(setDoc(doc(as('alice'), 'invitations', id), newInvite({ expiresAt: new Date(Date.now() + 30 * 864e5) })));
  await assertFails(setDoc(doc(as('alice'), 'invitations', id), newInvite({ expiresAt: ago(10) })));
  await assertFails(setDoc(doc(as('alice'), 'invitations', id), newInvite({ acceptedBy: 'alice' })));
  await assertFails(setDoc(doc(as('alice'), 'invitations', inv('orgB', 'new@x.io')), newInvite({ organizationId: 'orgB' })));
  await assertFails(setDoc(doc(as('carol'), 'invitations', id), newInvite()));
  await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), 'invitations', id), newInvite()));
});
test('INVITATION OVERWRITE: another organisation can never touch, replace, consume or delete an invitation (pending, expired or consumed)', async () => {
  const c = as('carol');
  for (const email of [EMAIL.erin, EMAIL.frank, EMAIL.hank]) {
    const ref = doc(c, 'invitations', inv('orgA', email));
    await assertFails(setDoc(ref, newInvite({ email, organizationId: 'orgB', organizationName: 'B', invitedBy: 'carol' })));
    await assertFails(setDoc(ref, newInvite({ email, organizationId: 'orgA', invitedBy: 'carol' })));
    await assertFails(updateDoc(ref, { status: 'pending', expiresAt: inDays(7) }));
    await assertFails(updateDoc(ref, { role: 'admin' }));
    await assertFails(deleteDoc(ref));
    await assertFails(getDoc(ref));
  }
  await assertSucceeds(setDoc(doc(c, 'invitations', inv('orgB', EMAIL.erin)), newInvite({ email: EMAIL.erin, organizationId: 'orgB', organizationName: 'B', invitedBy: 'carol' })));
  const mine = await getDocs(query(collection(as('erin'), 'invitations'), where('email', '==', EMAIL.erin)));
  assert2(mine.size === 2, "invitee sees both organisations' invitations");
  await assertSucceeds(getDoc(doc(as('alice'), 'invitations', inv('orgA', EMAIL.erin))));
});
test('invitation re-issue: only the inviting org may reset or extend its own invitation (also after it was consumed)', async () => {
  await assertSucceeds(setDoc(doc(as('alice'), 'invitations', inv('orgA', EMAIL.erin)), newInvite({ email: EMAIL.erin, role: 'user' })));
  await assertSucceeds(setDoc(doc(as('alice'), 'invitations', inv('orgA', EMAIL.hank)), newInvite({ email: EMAIL.hank })));
  await assertSucceeds(setDoc(doc(as('alice'), 'invitations', inv('orgA', EMAIL.frank)), newInvite({ email: EMAIL.frank })));
  await assertFails(setDoc(doc(as('bob'), 'invitations', inv('orgA', EMAIL.erin)), newInvite({ email: EMAIL.erin, invitedBy: 'bob' })));
});

// ------------------------------------------------------------------ invitations: reading / cancelling
test('invitation read/list/delete boundaries', async () => {
  const e = as('erin');
  await assertSucceeds(getDoc(doc(e, 'invitations', inv('orgA', EMAIL.erin))));
  await assertSucceeds(getDocs(query(collection(e, 'invitations'), where('email', '==', EMAIL.erin))));
  await assertFails(getDocs(query(collection(e, 'invitations'), where('email', '==', EMAIL.frank))));
  await assertFails(getDocs(collection(e, 'invitations')));
  await assertFails(getDoc(doc(as('dave'), 'invitations', inv('orgA', EMAIL.erin))));
  await assertFails(getDoc(doc(as('bob'), 'invitations', inv('orgA', EMAIL.erin))));
  await assertSucceeds(getDoc(doc(as('alice'), 'invitations', inv('orgA', EMAIL.erin))));
  await assertSucceeds(getDocs(query(collection(as('alice'), 'invitations'), where('organizationId', '==', 'orgA'))));
  await assertFails(getDocs(query(collection(as('carol'), 'invitations'), where('organizationId', '==', 'orgA'))));
  await assertFails(deleteDoc(doc(as('carol'), 'invitations', inv('orgA', EMAIL.erin))));
  await assertFails(deleteDoc(doc(e, 'invitations', inv('orgA', EMAIL.erin))));
  await assertSucceeds(deleteDoc(doc(as('alice'), 'invitations', inv('orgA', EMAIL.erin))));
});

// ------------------------------------------------------------------ invitations: atomic acceptance
test('INVITE FLOW: atomic accept+join succeeds once; the member then sees only the inviting org', async () => {
  const e = as('erin');
  await assertSucceeds(acceptAndJoin(e, 'erin'));
  await assertSucceeds(getDoc(doc(e, 'documents', 'docA')));
  await assertFails(getDoc(doc(e, 'organizations', 'orgB')));
  await assertFails(deleteDoc(doc(e, 'documents', 'docA')));
  await assertFails(updateDoc(doc(e, 'users', 'erin'), { role: 'admin' }));
  await assertFails(updateDoc(doc(e, 'users', 'erin'), { organizationId: 'orgB', role: 'analyst' }));
  await assertFails(acceptAndJoin(e, 'erin'));
});
test('acceptance is ALL-OR-NOTHING: neither half works alone, and failed attempts leave nothing half-applied', async () => {
  const e = as('erin');
  await assertFails(acceptAndJoin(e, 'erin', { skipUser: true }));
  await assertFails(acceptAndJoin(e, 'erin', { skipInvite: true }));
  await assertFails(updateDoc(doc(e, 'users', 'erin'), { organizationId: 'orgA', role: 'analyst' }));
  let state;
  await env.withSecurityRulesDisabled(async (ctx) => { state = (await getDoc(doc(ctx.firestore(), 'invitations', inv('orgA', EMAIL.erin)))).data().status; });
  let userOrg;
  await env.withSecurityRulesDisabled(async (ctx) => { userOrg = (await getDoc(doc(ctx.firestore(), 'users', 'erin'))).data().organizationId; });
  assert2(userOrg === null, 'user not joined');
  assert2(state === 'pending', 'invitation still pending');
  await assertSucceeds(acceptAndJoin(e, 'erin'));
});
test('acceptance denied for: unverified email, wrong user/email, expired, tampered role/org, forged fields', async () => {
  await assertFails(acceptAndJoin(unverified('erin'), 'erin'));
  await assertFails(acceptAndJoin(as('dave'), 'dave', { email: EMAIL.erin, inviteDoc: inv('orgA', EMAIL.erin) }));
  await assertFails(acceptAndJoin(as('alice'), 'alice', { inviteDoc: inv('orgA', EMAIL.erin) }));
  await assertFails(acceptAndJoin(as('frank'), 'frank', { role: 'user' }));
  await assertFails(acceptAndJoin(as('erin'), 'erin', { role: 'admin' }));
  await assertFails(acceptAndJoin(as('erin'), 'erin', { org: 'orgB' }));
  await assertFails(acceptAndJoin(as('erin'), 'erin', { userPatch: { displayName: 'x' } }));
  await assertFails(acceptAndJoin(as('erin'), 'erin', { invitePatch: { acceptedBy: 'bob' } }));
  await assertFails(acceptAndJoin(as('erin'), 'erin', { invitePatch: { acceptedAt: ago(1) } }));
  await assertFails(acceptAndJoin(as('erin'), 'erin', { invitePatch: { role: 'admin' } }));
  await assertFails(acceptAndJoin(as('erin'), 'erin', { invitePatch: { organizationId: 'orgB' } }));
  await assertFails(acceptAndJoin(as('erin'), 'erin', { invitePatch: { expiresAt: inDays(300) } }));
});
test('STALE REJOIN: a consumed invitation cannot be reused, with or without any time window', async () => {
  const h = as('hank');                                                          // consumed 5 minutes ago, member since removed
  await assertFails(updateDoc(doc(h, 'users', 'hank'), { organizationId: 'orgA', role: 'analyst' }));
  await assertFails(acceptAndJoin(h, 'hank'));
  const e = as('erin');
  await assertSucceeds(acceptAndJoin(e, 'erin'));
  await assertSucceeds(updateDoc(doc(as('alice'), 'users', 'erin'), { organizationId: null, role: null }));   // removeMember()
  await assertFails(updateDoc(doc(e, 'users', 'erin'), { organizationId: 'orgA', role: 'analyst' }));
  await assertFails(acceptAndJoin(e, 'erin'));
  await assertSucceeds(setDoc(doc(as('alice'), 'invitations', inv('orgA', EMAIL.erin)), newInvite({ email: EMAIL.erin })));   // deliberate re-invite
  await assertSucceeds(acceptAndJoin(e, 'erin'));
});
test("nobody can join an arbitrary org or use another person's invitation", async () => {
  await assertFails(updateDoc(doc(as('dave'), 'users', 'dave'), { organizationId: 'orgA', role: 'user' }));
  await assertFails(updateDoc(doc(as('dave'), 'users', 'dave'), { organizationId: 'orgA', role: 'admin' }));
  await assertFails(acceptAndJoin(as('dave'), 'dave', { org: 'orgA', role: 'analyst', inviteDoc: inv('orgA', EMAIL.erin) }));
  await assertFails(updateDoc(doc(as('carol'), 'users', 'erin'), { organizationId: 'orgB', role: 'user' }));
  await assertFails(updateDoc(doc(as('alice'), 'users', 'erin'), { organizationId: 'orgA', role: 'user' }));
});

// ------------------------------------------------------------------ member management
test('PRIVILEGE ESCALATION: an org admin cannot move/plant users into another org; may change roles and remove members', async () => {
  const a = as('alice');
  await assertFails(updateDoc(doc(a, 'users', 'bob'), { organizationId: 'orgB' }));
  await assertFails(updateDoc(doc(a, 'users', 'bob'), { organizationId: 'orgB', role: 'admin' }));
  await assertFails(updateDoc(doc(a, 'users', 'bob'), { role: 'god' }));
  await assertFails(updateDoc(doc(a, 'users', 'bob'), { displayName: 'hax', email: 'x@y.z' }));
  await assertFails(updateDoc(doc(a, 'users', 'gina'), { role: 'admin' }));
  await assertSucceeds(updateDoc(doc(a, 'users', 'bob'), { role: 'compliance_officer' }));
  await assertSucceeds(updateDoc(doc(a, 'users', 'bob'), { organizationId: null, role: null }));
  await assertFails(updateDoc(doc(a, 'users', 'bob'), { organizationId: null, role: 'admin' }));
});
test('non-admin members cannot manage others', async () => {
  await assertFails(updateDoc(doc(as('bob'), 'users', 'alice'), { role: 'user' }));
  await assertFails(updateDoc(doc(as('bob'), 'users', 'bob'), { role: 'admin' }));
  await assertSucceeds(updateDoc(doc(as('bob'), 'users', 'bob'), { displayName: 'Bobby', photoURL: 'data:x', 'notificationPrefs.email': true }));
});

// ------------------------------------------------------------------ notifications (cross-tenant)
test('notifications: fan-out only to same-org members; no cross-org create/read/modify/move/reassign', async () => {
  const fan = (userId, org = 'orgA') => ({ userId, organizationId: org, title: 'Critical Compliance Gap Detected', body: 'x', level: 'Critical', read: false, createdAt: serverTimestamp() });
  await assertSucceeds(addDoc(collection(as('bob'), 'notifications'), fan('alice')));
  await assertSucceeds(addDoc(collection(as('bob'), 'notifications'), fan('bob')));
  await assertFails(addDoc(collection(as('bob'), 'notifications'), fan('carol')));
  await assertFails(addDoc(collection(as('bob'), 'notifications'), fan('carol', 'orgB')));
  await assertFails(addDoc(collection(as('bob'), 'notifications'), fan('gina', 'orgB')));
  await assertFails(addDoc(collection(as('carol'), 'notifications'), fan('bob')));
  await assertFails(addDoc(collection(as('bob'), 'notifications'), fan('nobody')));
  await assertFails(addDoc(collection(as('dave'), 'notifications'), fan('alice')));
  await assertFails(addDoc(collection(env.unauthenticatedContext().firestore(), 'notifications'), fan('alice')));
  await assertFails(getDoc(doc(as('alice'), 'notifications', 'nBob')));
  await assertFails(getDoc(doc(as('carol'), 'notifications', 'nBob')));
  await assertFails(getDocs(query(collection(as('carol'), 'notifications'), where('userId', '==', 'bob'))));
  await assertSucceeds(getDocs(query(collection(as('bob'), 'notifications'), where('userId', '==', 'bob'))));
  await assertSucceeds(updateDoc(doc(as('bob'), 'notifications', 'nBob'), { read: true }));
  await assertFails(updateDoc(doc(as('bob'), 'notifications', 'nBob'), { userId: 'carol' }));
  await assertFails(updateDoc(doc(as('bob'), 'notifications', 'nBob'), { organizationId: 'orgB' }));
  await assertFails(updateDoc(doc(as('bob'), 'notifications', 'nBob'), { title: 'edited', read: true }));
  await assertFails(updateDoc(doc(as('carol'), 'notifications', 'nBob'), { read: true }));
  await assertFails(deleteDoc(doc(as('alice'), 'notifications', 'nBob')));
  await assertSucceeds(deleteDoc(doc(as('bob'), 'notifications', 'nBob')));
});

// ------------------------------------------------------------------ shared regulations
test('shared regulations: read-only for every tenant user (admins included); only platform admins write', async () => {
  await assertSucceeds(getDoc(doc(as('bob'), 'regulations', 'reg1')));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'regulations', 'reg1')));
  for (const uid of ['bob', 'alice', 'carol', 'dave']) {
    await assertFails(setDoc(doc(as(uid), 'regulations', 'reg1'), { name: 'tampered' }));
    await assertFails(setDoc(doc(as(uid), 'regulations', 'new'), { name: 'x' }, { merge: true }));
    await assertFails(deleteDoc(doc(as(uid), 'regulations', 'reg1')));
  }
  const root = as('root');
  await assertSucceeds(setDoc(doc(root, 'regulations', 'reg1'), { name: 'GDPR', lastSyncedAt: serverTimestamp(), source: 'manual-seed' }, { merge: true }));
  await assertSucceeds(setDoc(doc(root, 'regulations', 'reg2'), { name: 'DPDP' }));
});

// ------------------------------------------------------------------ reserved / immutable fields
test('ownership fields are immutable on documents, reports, risk records, issues', async () => {
  const b = as('bob');
  await assertFails(updateDoc(doc(b, 'documents', 'docA'), { uploadedBy: 'alice' }));
  await assertFails(updateDoc(doc(b, 'documents', 'docA'), { uploadedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(b, 'complianceReports', 'repA'), { createdAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(b, 'riskAssessments', 'riskA'), { createdAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(b, 'complianceIssues', 'issA'), { documentId: 'other' }));
  await assertFails(updateDoc(doc(b, 'complianceIssues', 'issA'), { createdAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(b, 'documents', 'docA'), { organizationId: 'orgB' }));
  await assertFails(updateDoc(doc(as('carol'), 'complianceReports', 'repA'), { organizationId: 'orgB' }));
});

// ------------------------------------------------------------------ regression: everyday workflows
test('REGRESSION member workflow: upload, analyse, raise + resolve issues, report, risk assessment, chat, audit', async () => {
  const b = as('bob');
  await assertSucceeds(setDoc(doc(b, 'documents', 'dB'), { name: 'p.pdf', contentType: 'application/pdf', size: '1 KB', country: 'India', domain: null, uploadedAt: serverTimestamp(), organizationId: 'orgA', uploadedBy: 'bob', status: 'processing' }));
  await assertSucceeds(updateDoc(doc(b, 'documents', 'dB'), { extractedText: 'text' }));
  await assertSucceeds(updateDoc(doc(b, 'documents', 'dB'), { status: 'analyzed', score: 72, gaps: [] }));
  await assertSucceeds(addDoc(collection(b, 'complianceIssues'), { organizationId: 'orgA', documentId: 'dB', title: 'g', description: '', severity: 'High', status: 'Open', createdAt: serverTimestamp(), recommendation: '' }));
  await assertSucceeds(updateDoc(doc(b, 'complianceIssues', 'issA'), { status: 'Resolved' }));
  await assertSucceeds(addDoc(collection(b, 'complianceReports'), { organizationId: 'orgA', title: 'R', createdAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(b, 'complianceReports', 'repA'), { summary: 'regenerated' }));
  await assertSucceeds(addDoc(collection(b, 'riskAssessments'), { organizationId: 'orgA', score: 55, createdAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(b, 'riskAssessments', 'riskA'), { score: 11 }));
  await assertSucceeds(addDoc(collection(b, 'auditLogs'), { organizationId: 'orgA', actorUid: 'bob', action: 'x', target: 'y', status: 'success', timestamp: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(b, 'chatConversations', 'c1'), { userId: 'bob', title: 't' }));
  await assertSucceeds(setDoc(doc(b, 'chatConversations', 'c1', 'messages', 'm1'), { role: 'user', text: 'hi' }));
  await assertSucceeds(setDoc(doc(b, 'rateLimits', 'bob', 'buckets', 'chat'), { count: 1 }));
  await assertFails(setDoc(doc(b, 'rateLimits', 'alice', 'buckets', 'chat'), { count: 1 }));
  await assertFails(deleteDoc(doc(b, 'documents', 'docA')));
  await assertFails(deleteDoc(doc(b, 'complianceReports', 'repA')));
  await assertFails(getDoc(doc(as('carol'), 'documents', 'dB')));
});
test('REGRESSION admin workflow: delete document/report, rename org, read team + audit logs, cancel invite', async () => {
  const a = as('alice');
  await assertSucceeds(deleteDoc(doc(a, 'documents', 'docA')));
  await assertSucceeds(deleteDoc(doc(a, 'complianceReports', 'repA')));
  await assertSucceeds(deleteDoc(doc(a, 'riskAssessments', 'riskA')));
  await assertFails(deleteDoc(doc(a, 'complianceIssues', 'issA')));
  await assertSucceeds(updateDoc(doc(a, 'organizations', 'orgA'), { name: 'Acme' }));
  await assertSucceeds(getDoc(doc(a, 'users', 'bob')));
  await assertFails(getDoc(doc(a, 'users', 'gina')));
  await assertSucceeds(deleteDoc(doc(a, 'invitations', inv('orgA', EMAIL.erin))));
});
