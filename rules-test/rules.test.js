'use strict';
// Tests firestore.rules against the real Firestore emulator (no real project, no real data).
// Run: npm run rules:test   (from ord/; starts the emulator via firebase-tools)
const { test, before, after, beforeEach } = require('node:test');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp } = require('firebase/firestore');
const fs = require('node:fs');
const path = require('node:path');

let env;
const [HOST, PORT] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8081').split(':');

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-ordinex', firestore: { host: HOST, port: Number(PORT), rules: fs.readFileSync(process.env.RULES_FILE || path.join(__dirname, '..', 'firestore.rules'), 'utf8') } });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const u = (uid, org, role) => setDoc(doc(db, 'users', uid), { uid, organizationId: org, role });
    await Promise.all([
      u('alice', 'orgA', 'admin'), u('bob', 'orgA', 'analyst'), u('carol', 'orgB', 'admin'), u('dave', null, null),
      setDoc(doc(db, 'organizations', 'orgA'), { name: 'A', createdBy: 'alice', plan: 'starter', seats: 5 }),
      setDoc(doc(db, 'organizations', 'orgB'), { name: 'B', createdBy: 'carol', plan: 'starter', seats: 5 }),
      setDoc(doc(db, 'documents', 'docA'), { organizationId: 'orgA', uploadedBy: 'alice', name: 'a.pdf' }),
      setDoc(doc(db, 'complianceReports', 'repA'), { organizationId: 'orgA', title: 'A report' }),
      setDoc(doc(db, 'riskAssessments', 'riskA'), { organizationId: 'orgA', score: 10 }),
      setDoc(doc(db, 'complianceIssues', 'issA'), { organizationId: 'orgA', title: 'gap' }),
      setDoc(doc(db, 'notifications', 'nA'), { userId: 'alice', organizationId: 'orgA' }),
      setDoc(doc(db, 'chatConversations', 'cA'), { userId: 'alice' }),
      setDoc(doc(db, 'auditLogs', 'lA'), { organizationId: 'orgA', actorUid: 'alice' }),
      setDoc(doc(db, 'platformAdmins', 'root'), { x: 1 }),
      setDoc(doc(db, 'regulations', 'r1'), { name: 'GDPR' }),
    ]);
  });
});
const as = (uid) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

test('unauthenticated users can read nothing', async () => {
  for (const p of [['documents', 'docA'], ['users', 'alice'], ['organizations', 'orgA'], ['regulations', 'r1'], ['complianceReports', 'repA']]) await assertFails(getDoc(doc(anon(), ...p)));
});
test('org isolation: members read their org; other orgs cannot', async () => {
  await assertSucceeds(getDoc(doc(as('bob'), 'documents', 'docA')));
  await assertFails(getDoc(doc(as('carol'), 'documents', 'docA')));
  await assertFails(getDoc(doc(as('carol'), 'complianceReports', 'repA')));
  await assertFails(getDoc(doc(as('carol'), 'riskAssessments', 'riskA')));
  await assertFails(getDoc(doc(as('dave'), 'organizations', 'orgA')));      // org-less users (null == null case)
  await assertFails(getDoc(doc(as('carol'), 'users', 'alice')));
});
test('PRIVILEGE ESCALATION: a new user cannot create their own profile as admin of an existing org', async () => {
  await assertFails(setDoc(doc(as('mallory'), 'users', 'mallory'), { uid: 'mallory', role: 'admin', organizationId: 'orgA' }));
  await assertFails(setDoc(doc(as('mallory'), 'users', 'mallory'), { uid: 'mallory', role: 'admin', organizationId: null }));
  await assertFails(setDoc(doc(as('mallory'), 'users', 'mallory'), { uid: 'mallory', role: null, organizationId: 'orgA' }));
  await assertFails(setDoc(doc(as('mallory'), 'users', 'someoneelse'), { uid: 'someoneelse', role: null, organizationId: null }));
  await assertSucceeds(setDoc(doc(as('mallory'), 'users', 'mallory'), { uid: 'mallory', role: null, organizationId: null, email: 'm@x.io' })); // what ensureUserProfile writes
});
test('users cannot self-promote or switch org; bootstrap works only for an org they created', async () => {
  await assertFails(updateDoc(doc(as('bob'), 'users', 'bob'), { role: 'admin' }));
  await assertFails(updateDoc(doc(as('bob'), 'users', 'bob'), { organizationId: 'orgB' }));
  await assertSucceeds(updateDoc(doc(as('bob'), 'users', 'bob'), { displayName: 'Bobby' }));
  await assertFails(updateDoc(doc(as('dave'), 'users', 'dave'), { role: 'admin', organizationId: 'orgA' }));   // not created by dave
  await assertSucceeds(setDoc(doc(as('dave'), 'organizations', 'orgD'), { name: 'D', createdBy: 'dave', plan: 'starter', seats: 5 }));
  await assertSucceeds(updateDoc(doc(as('dave'), 'users', 'dave'), { role: 'admin', organizationId: 'orgD' }));
});
test('documents: create only into own org as self; no cross-org move or overwrite', async () => {
  await assertSucceeds(setDoc(doc(as('bob'), 'documents', 'd2'), { organizationId: 'orgA', uploadedBy: 'bob' }));
  await assertFails(setDoc(doc(as('bob'), 'documents', 'd3'), { organizationId: 'orgB', uploadedBy: 'bob' }));
  await assertFails(setDoc(doc(as('bob'), 'documents', 'd4'), { organizationId: 'orgA', uploadedBy: 'alice' }));
  await assertSucceeds(updateDoc(doc(as('bob'), 'documents', 'docA'), { status: 'analyzed' }));
  await assertFails(updateDoc(doc(as('bob'), 'documents', 'docA'), { organizationId: 'orgB' }));
  await assertFails(updateDoc(doc(as('carol'), 'documents', 'docA'), { status: 'x' }));
  await assertFails(deleteDoc(doc(as('bob'), 'documents', 'docA')));            // analyst cannot delete
  await assertSucceeds(deleteDoc(doc(as('alice'), 'documents', 'docA')));
});
test('CROSS-ORG OVERWRITE: another org cannot hijack reports/risk records by writing its own organizationId', async () => {
  for (const [c, id] of [['complianceReports', 'repA'], ['riskAssessments', 'riskA']]) {
    await assertFails(setDoc(doc(as('carol'), c, id), { organizationId: 'orgB', hijacked: true }));
    await assertFails(updateDoc(doc(as('carol'), c, id), { organizationId: 'orgB' }));
    await assertFails(updateDoc(doc(as('bob'), c, id), { organizationId: 'orgB' }));
    await assertSucceeds(updateDoc(doc(as('bob'), c, id), { note: 'ok' }));
    await assertSucceeds(setDoc(doc(as('bob'), c, id + '2'), { organizationId: 'orgA' }));
    await assertFails(setDoc(doc(as('bob'), c, id + '3'), { organizationId: 'orgB' }));
  }
});
test('compliance issues: org-scoped update that cannot change org; never deletable', async () => {
  await assertSucceeds(updateDoc(doc(as('bob'), 'complianceIssues', 'issA'), { status: 'resolved' }));
  await assertFails(updateDoc(doc(as('bob'), 'complianceIssues', 'issA'), { organizationId: 'orgB' }));
  await assertFails(updateDoc(doc(as('carol'), 'complianceIssues', 'issA'), { status: 'resolved' }));
  await assertFails(deleteDoc(doc(as('alice'), 'complianceIssues', 'issA')));
});
test('notifications and chats are private to their user and cannot be re-assigned', async () => {
  await assertFails(getDoc(doc(as('bob'), 'notifications', 'nA')));
  await assertFails(updateDoc(doc(as('bob'), 'notifications', 'nA'), { read: true }));
  await assertSucceeds(updateDoc(doc(as('alice'), 'notifications', 'nA'), { read: true }));
  await assertFails(updateDoc(doc(as('alice'), 'notifications', 'nA'), { userId: 'bob' }));
  await assertFails(getDoc(doc(as('bob'), 'chatConversations', 'cA')));
  await assertFails(updateDoc(doc(as('alice'), 'chatConversations', 'cA'), { userId: 'bob' }));
  await assertSucceeds(updateDoc(doc(as('alice'), 'chatConversations', 'cA'), { title: 't' }));
});
test('audit logs: admins of the org read; immutable; actor must be the caller', async () => {
  await assertSucceeds(getDoc(doc(as('alice'), 'auditLogs', 'lA')));
  await assertFails(getDoc(doc(as('bob'), 'auditLogs', 'lA')));
  await assertFails(getDoc(doc(as('carol'), 'auditLogs', 'lA')));
  await assertFails(updateDoc(doc(as('alice'), 'auditLogs', 'lA'), { actorUid: 'x' }));
  await assertFails(deleteDoc(doc(as('alice'), 'auditLogs', 'lA')));
  await assertSucceeds(setDoc(doc(as('bob'), 'auditLogs', 'l2'), { organizationId: 'orgA', actorUid: 'bob' }));
  await assertFails(setDoc(doc(as('bob'), 'auditLogs', 'l3'), { organizationId: 'orgA', actorUid: 'alice' }));
});
test('platformAdmins and unknown collections are closed; regulations writable only by platform admins', async () => {
  await assertFails(getDoc(doc(as('alice'), 'platformAdmins', 'root')));
  await assertFails(setDoc(doc(as('alice'), 'platformAdmins', 'alice'), { x: 1 }));      // cannot grant yourself platform admin
  await assertFails(setDoc(doc(as('alice'), 'secrets', 's'), { x: 1 }));
  await assertFails(getDoc(doc(as('alice'), 'secrets', 's')));
  await assertSucceeds(getDoc(doc(as('bob'), 'regulations', 'r1')));
  await assertFails(setDoc(doc(as('bob'), 'regulations', 'r2'), { name: 'x' }));
  await assertFails(setDoc(doc(as('alice'), 'regulations', 'r2'), { name: 'x' }));          // org admins are read-only now (see access.test.js)
  await assertSucceeds(setDoc(doc(as('root'), 'regulations', 'r2'), { name: 'x' }));          // platform admin
});

