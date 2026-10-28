'use strict';
// Second rules suite: invitations, member management, notifications, shared regulations, reserved fields,
// and regression tests for sign-up / org creation / everyday workflows. Runs against the Firestore EMULATOR.
// Payloads mirror what public/ordinex.html writes. (The SPA itself is NOT run against the emulator.)
const { test, before, after, beforeEach } = require('node:test');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, serverTimestamp, Timestamp } = require('firebase/firestore');
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
const EMAIL = { alice: 'alice@a.io', bob: 'bob@a.io', carol: 'carol@b.io', dave: 'dave@x.io', erin: 'erin@x.io', frank: 'frank@x.io' };

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const u = (uid, org, role) => setDoc(doc(db, 'users', uid), { uid, organizationId: org, role, email: EMAIL[uid] || null });
    await Promise.all([
      u('alice', 'orgA', 'admin'), u('bob', 'orgA', 'analyst'), u('carol', 'orgB', 'admin'), u('dave', null, null), u('erin', null, null), u('frank', null, null), u('gina', 'orgB', 'user'),
      setDoc(doc(db, 'organizations', 'orgA'), { name: 'A', createdBy: 'alice', plan: 'starter' }),
      setDoc(doc(db, 'organizations', 'orgB'), { name: 'B', createdBy: 'carol', plan: 'starter' }),
      setDoc(doc(db, 'platformAdmins', 'root'), { x: 1 }), setDoc(doc(db, 'users', 'root'), { uid: 'root', organizationId: null, role: null }),
      setDoc(doc(db, 'regulations', 'reg1'), { name: 'GDPR', countryCode: 'EU' }),
      setDoc(doc(db, 'documents', 'docA'), { organizationId: 'orgA', uploadedBy: 'bob', uploadedAt: ago(60), status: 'analyzed', name: 'a.pdf' }),
      setDoc(doc(db, 'complianceReports', 'repA'), { organizationId: 'orgA', createdAt: ago(60), title: 't' }),
      setDoc(doc(db, 'riskAssessments', 'riskA'), { organizationId: 'orgA', createdAt: ago(60), score: 10 }),
      setDoc(doc(db, 'complianceIssues', 'issA'), { organizationId: 'orgA', documentId: 'docA', createdAt: ago(60), status: 'Open', severity: 'High' }),
      setDoc(doc(db, 'notifications', 'nBob'), { userId: 'bob', organizationId: 'orgA', read: false, title: 't' }),
      // pending invitation for erin -> orgA as analyst
      setDoc(doc(db, 'invitations', EMAIL.erin), { email: EMAIL.erin, organizationId: 'orgA', organizationName: 'A', role: 'analyst', invitedBy: 'alice', status: 'pending', createdAt: ago(5), expiresAt: inDays(7) }),
      // expired invitation for frank
      setDoc(doc(db, 'invitations', EMAIL.frank), { email: EMAIL.frank, organizationId: 'orgA', organizationName: 'A', role: 'user', invitedBy: 'alice', status: 'pending', createdAt: ago(60 * 24 * 20), expiresAt: Timestamp.fromMillis(Date.now() - 864e5) }),
    ]);
  });
});
const as = (uid, claims = {}) => env.authenticatedContext(uid, { email: EMAIL[uid], email_verified: true, ...claims }).firestore();
const unverified = (uid) => env.authenticatedContext(uid, { email: EMAIL[uid], email_verified: false }).firestore();
const newInvite = (over = {}) => ({ email: 'new@x.io', organizationId: 'orgA', organizationName: 'A', role: 'analyst', invitedBy: 'alice', status: 'pending', createdAt: serverTimestamp(), expiresAt: inDays(7), ...over });
const acceptAs = (uid, db) => updateDoc(doc(db, 'invitations', EMAIL[uid]), { status: 'accepted', acceptedBy: uid, acceptedAt: serverTimestamp() });

// ------------------------------------------------------------------ regression: sign-up + org creation
test('REGRESSION sign-up -> create organization -> become admin -> use the workspace (exact app sequence)', async () => {
  const db = as('newbie'); // fresh uid, no profile yet
  await assertSucceeds(setDoc(doc(db, 'users', 'newbie'), { uid: 'newbie', email: 'n@x.io', displayName: 'n', photoURL: null, role: null, organizationId: null, createdAt: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(db, 'organizations', 'orgN'), { name: 'N', plan: 'starter', seats: 5, createdBy: 'newbie', createdAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, 'users', 'newbie'), { organizationId: 'orgN', role: 'admin' }));
  await assertSucceeds(addDoc(collection(db, 'auditLogs'), { organizationId: 'orgN', actorUid: 'newbie', action: 'Organization created', target: 'N', status: 'success', timestamp: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(db, 'documents', 'dN'), { organizationId: 'orgN', uploadedBy: 'newbie', name: 'x.pdf', status: 'processing', uploadedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(db, 'documents', 'dN')));
  await assertFails(getDoc(doc(as('carol'), 'documents', 'dN')));            // still isolated
});
test('a signed-up user cannot adopt an org they did not create (bootstrap abuse) or set createdBy later', async () => {
  const db = as('dave');
  await assertFails(updateDoc(doc(db, 'users', 'dave'), { organizationId: 'orgB', role: 'admin' }));
  await assertSucceeds(setDoc(doc(db, 'organizations', 'orgD'), { name: 'D', createdBy: 'dave' }));
  await assertFails(updateDoc(doc(as('alice'), 'organizations', 'orgA'), { createdBy: 'dave' }));   // admin cannot hand out bootstrap rights
  await assertSucceeds(updateDoc(doc(as('alice'), 'organizations', 'orgA'), { name: 'A2' }));
});

// ------------------------------------------------------------------ invitations: creation
test('invitation create: org admin only, correct id/email/role/expiry/shape', async () => {
  await assertSucceeds(setDoc(doc(as('alice'), 'invitations', 'new@x.io'), newInvite()));
  await assertFails(setDoc(doc(as('bob'), 'invitations', 'new@x.io'), newInvite({ invitedBy: 'bob' })));                 // analyst
  await assertFails(setDoc(doc(as('carol'), 'invitations', 'new@x.io'), newInvite()));                                      // admin of ANOTHER org inviting into orgA
  await assertFails(setDoc(doc(as('alice'), 'invitations', 'other@x.io'), newInvite()));                                    // id != email
  await assertFails(setDoc(doc(as('alice'), 'invitations', 'New@x.io'), newInvite({ email: 'New@x.io' })));               // not lower-case
  await assertFails(setDoc(doc(as('alice'), 'invitations', 'new@x.io'), newInvite({ role: 'superuser' })));
  await assertFails(setDoc(doc(as('alice'), 'invitations', 'new@x.io'), newInvite({ role: 'platform_admin' })));
  await assertFails(setDoc(doc(as('alice'), 'invitations', 'new@x.io'), newInvite({ status: 'accepted' })));
  await assertFails(setDoc(doc(as('alice'), 'invitations', 'new@x.io'), newInvite({ invitedBy: 'carol' })));
  await assertFails(setDoc(doc(as('alice'), 'invitations', 'new@x.io'), newInvite({ expiresAt: inDays(60) })));            // too long-lived
  await assertFails(setDoc(doc(as('alice'), 'invitations', 'new@x.io'), newInvite({ expiresAt: ago(10) })));               // already expired
  await assertFails(setDoc(doc(as('alice'), 'invitations', 'new@x.io'), newInvite({ acceptedBy: 'alice' })));              // extra field
  await assertFails(setDoc(doc(as('alice'), 'invitations', 'new@x.io'), newInvite({ organizationId: 'orgB' })));           // admin of A, org B
  await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), 'invitations', 'new@x.io'), newInvite()));
});
test('invitation create with the EXACT payload sendInvite() writes (expiresAt is a JS Date, 14 days)', async () => {
  await assertSucceeds(setDoc(doc(as('alice'), 'invitations', 'new@x.io'), { email: 'new@x.io', organizationId: 'orgA', organizationName: 'A', role: 'analyst', invitedBy: 'alice', status: 'pending', createdAt: serverTimestamp(), expiresAt: new Date(Date.now() + 14 * 24 * 3600 * 1000) }));
  await assertFails(setDoc(doc(as('alice'), 'invitations', 'late@x.io'), { email: 'late@x.io', organizationId: 'orgA', organizationName: 'A', role: 'analyst', invitedBy: 'alice', status: 'pending', createdAt: serverTimestamp(), expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) }));
});
test('invitation re-invite: own org may reset; another org may not hijack a LIVE invitation but may replace a finished/expired one', async () => {
  await assertSucceeds(setDoc(doc(as('alice'), 'invitations', EMAIL.erin), newInvite({ email: EMAIL.erin, role: 'user' })));          // own org
  await assertFails(setDoc(doc(as('carol'), 'invitations', EMAIL.erin), newInvite({ email: EMAIL.erin, organizationId: 'orgB', organizationName: 'B', invitedBy: 'carol' })));  // live invite of orgA
  await assertSucceeds(setDoc(doc(as('carol'), 'invitations', EMAIL.frank), newInvite({ email: EMAIL.frank, organizationId: 'orgB', organizationName: 'B', invitedBy: 'carol' }))); // expired one
});

// ------------------------------------------------------------------ invitations: reading / cancelling
test('invitation read/list/delete boundaries', async () => {
  await assertSucceeds(getDoc(doc(as('erin'), 'invitations', EMAIL.erin)));                      // invitee
  await assertSucceeds(getDoc(doc(as('alice'), 'invitations', EMAIL.erin)));                     // inviting org admin
  await assertFails(getDoc(doc(as('dave'), 'invitations', EMAIL.erin)));                         // unrelated user
  await assertFails(getDoc(doc(as('carol'), 'invitations', EMAIL.erin)));                        // other org's admin
  await assertFails(getDoc(doc(as('bob'), 'invitations', EMAIL.erin)));                          // non-admin member
  await assertSucceeds(getDocs(query(collection(as('alice'), 'invitations'), where('organizationId', '==', 'orgA'))));
  await assertFails(getDocs(query(collection(as('carol'), 'invitations'), where('organizationId', '==', 'orgA'))));
  await assertFails(getDocs(collection(as('dave'), 'invitations')));                             // no enumerating everyone's invites
  await assertFails(deleteDoc(doc(as('carol'), 'invitations', EMAIL.erin)));
  await assertFails(deleteDoc(doc(as('erin'), 'invitations', EMAIL.erin)));
  await assertSucceeds(deleteDoc(doc(as('alice'), 'invitations', EMAIL.erin)));                  // cancel
});

// ------------------------------------------------------------------ invitations: acceptance + joining
test('INVITE FLOW end to end: accept then join; then the member sees only the inviting org', async () => {
  const e = as('erin');
  await assertSucceeds(acceptAs('erin', e));
  await assertSucceeds(updateDoc(doc(e, 'users', 'erin'), { organizationId: 'orgA', role: 'analyst' }));
  await assertSucceeds(getDoc(doc(e, 'documents', 'docA')));
  await assertFails(getDoc(doc(e, 'organizations', 'orgB')));
  await assertFails(deleteDoc(doc(e, 'documents', 'docA')));                                      // analyst role was applied, not admin
  // replay: she is now in an org, so the invitation cannot be used to change anything
  await assertSucceeds(updateDoc(doc(e, 'users', 'erin'), { organizationId: 'orgA', role: 'analyst' }));   // identical values = harmless no-op
  await assertFails(updateDoc(doc(e, 'users', 'erin'), { role: 'admin' }));                                  // cannot upgrade afterwards
  await assertFails(updateDoc(doc(e, 'users', 'erin'), { organizationId: 'orgB', role: 'analyst' }));        // cannot hop orgs
  await assertFails(acceptAs('erin', e));                                                         // single use: no longer pending
});
test('invitation acceptance is denied for: unverified email, wrong user, expired, replay, tampering', async () => {
  await assertFails(acceptAs('erin', unverified('erin')));                                        // email squatting / unverified
  await assertFails(updateDoc(doc(as('dave'), 'invitations', EMAIL.erin), { status: 'accepted', acceptedBy: 'dave', acceptedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('alice'), 'invitations', EMAIL.erin), { status: 'accepted', acceptedBy: 'alice', acceptedAt: serverTimestamp() }));  // inviter cannot accept for the invitee
  await assertFails(acceptAs('frank', as('frank')));                                              // expired
  await assertFails(updateDoc(doc(as('erin'), 'invitations', EMAIL.erin), { status: 'accepted', acceptedBy: 'bob', acceptedAt: serverTimestamp() }));  // acceptedBy must be self
  await assertFails(updateDoc(doc(as('erin'), 'invitations', EMAIL.erin), { status: 'accepted', acceptedBy: 'erin', acceptedAt: ago(1) }));            // forged timestamp
  await assertFails(updateDoc(doc(as('erin'), 'invitations', EMAIL.erin), { status: 'accepted', acceptedBy: 'erin', acceptedAt: serverTimestamp(), role: 'admin' }));          // upgrade role while accepting
  await assertFails(updateDoc(doc(as('erin'), 'invitations', EMAIL.erin), { status: 'accepted', acceptedBy: 'erin', acceptedAt: serverTimestamp(), organizationId: 'orgB' }));  // retarget org
});
test('joining requires an accepted invitation for the caller\'s own email, with exactly its org and role', async () => {
  const e = as('erin');
  await assertFails(updateDoc(doc(e, 'users', 'erin'), { organizationId: 'orgA', role: 'analyst' }));          // not accepted yet
  await assertSucceeds(acceptAs('erin', e));
  await assertFails(updateDoc(doc(e, 'users', 'erin'), { organizationId: 'orgA', role: 'admin' }));            // role escalation
  await assertFails(updateDoc(doc(e, 'users', 'erin'), { organizationId: 'orgB', role: 'analyst' }));          // wrong org
  await assertFails(updateDoc(doc(e, 'users', 'erin'), { organizationId: 'orgA', role: 'analyst', displayName: 'x' }));   // extra field
  await assertFails(updateDoc(doc(unverified('erin'), 'users', 'erin'), { organizationId: 'orgA', role: 'analyst' }));    // unverified token
  await assertSucceeds(updateDoc(doc(e, 'users', 'erin'), { organizationId: 'orgA', role: 'analyst' }));
});
test('nobody can join an arbitrary org or use someone else\'s invitation', async () => {
  await assertFails(updateDoc(doc(as('dave'), 'users', 'dave'), { organizationId: 'orgA', role: 'user' }));      // no invitation at all
  await assertFails(updateDoc(doc(as('dave'), 'users', 'dave'), { organizationId: 'orgA', role: 'admin' }));
  await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(doc(ctx.firestore(), 'invitations', EMAIL.erin), { status: 'accepted', acceptedBy: 'erin', acceptedAt: serverTimestamp() }); });
  await assertFails(updateDoc(doc(as('dave'), 'users', 'dave'), { organizationId: 'orgA', role: 'analyst' }));   // erin's accepted invite is not dave's
  await assertFails(updateDoc(doc(as('carol'), 'users', 'erin'), { organizationId: 'orgB', role: 'user' }));     // other org's admin cannot pull erin in
});
test('an accepted invitation older than the 10-minute join window cannot be used to join', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(doc(ctx.firestore(), 'invitations', EMAIL.erin), { status: 'accepted', acceptedBy: 'erin', acceptedAt: ago(30) }); });
  await assertFails(updateDoc(doc(as('erin'), 'users', 'erin'), { organizationId: 'orgA', role: 'analyst' }));
});

// ------------------------------------------------------------------ member management
test('PRIVILEGE ESCALATION: an org admin cannot move/plant users into another org; may change roles and remove members', async () => {
  const a = as('alice');
  await assertFails(updateDoc(doc(a, 'users', 'bob'), { organizationId: 'orgB' }));                              // plant into orgB
  await assertFails(updateDoc(doc(a, 'users', 'bob'), { organizationId: 'orgB', role: 'admin' }));
  await assertFails(updateDoc(doc(a, 'users', 'bob'), { role: 'god' }));
  await assertFails(updateDoc(doc(a, 'users', 'bob'), { displayName: 'hax', email: 'x@y.z' }));                  // not the admin's data to edit
  await assertFails(updateDoc(doc(a, 'users', 'gina'), { role: 'admin' }));                                      // member of ANOTHER org
  await assertSucceeds(updateDoc(doc(a, 'users', 'bob'), { role: 'compliance_officer' }));
  await assertSucceeds(updateDoc(doc(a, 'users', 'bob'), { organizationId: null, role: null }));                // removeMember()
  await assertFails(updateDoc(doc(a, 'users', 'bob'), { organizationId: null, role: 'admin' }));                 // half-removed
});
test('non-admin members cannot manage others', async () => {
  await assertFails(updateDoc(doc(as('bob'), 'users', 'alice'), { role: 'user' }));
  await assertFails(updateDoc(doc(as('bob'), 'users', 'bob'), { role: 'admin' }));
  await assertSucceeds(updateDoc(doc(as('bob'), 'users', 'bob'), { displayName: 'Bobby', photoURL: 'data:x', 'notificationPrefs.email': true }));
});

// ------------------------------------------------------------------ notifications
test('notifications: fan-out only to same-org members; no cross-org create/read/modify/move/reassign', async () => {
  const fan = (userId, org = 'orgA') => ({ userId, organizationId: org, title: 'Critical Compliance Gap Detected', body: 'x', level: 'Critical', read: false, createdAt: serverTimestamp() });
  await assertSucceeds(addDoc(collection(as('bob'), 'notifications'), fan('alice')));                      // same-org colleague (what notifyOrgOfHighSeverityIssue writes)
  await assertSucceeds(addDoc(collection(as('bob'), 'notifications'), fan('bob')));
  await assertFails(addDoc(collection(as('bob'), 'notifications'), fan('carol')));                         // recipient in another tenant
  await assertFails(addDoc(collection(as('bob'), 'notifications'), fan('carol', 'orgB')));                 // claiming the other org
  await assertFails(addDoc(collection(as('bob'), 'notifications'), fan('nobody')));                        // non-existent recipient
  await assertFails(addDoc(collection(as('dave'), 'notifications'), fan('alice')));                        // caller without an org
  await assertFails(addDoc(collection(env.unauthenticatedContext().firestore(), 'notifications'), fan('alice')));
  await assertFails(getDoc(doc(as('alice'), 'notifications', 'nBob')));                                   // other users' notifications
  await assertFails(getDoc(doc(as('carol'), 'notifications', 'nBob')));
  await assertSucceeds(updateDoc(doc(as('bob'), 'notifications', 'nBob'), { read: true }));
  await assertFails(updateDoc(doc(as('bob'), 'notifications', 'nBob'), { userId: 'carol' }));              // reassign to another tenant
  await assertFails(updateDoc(doc(as('bob'), 'notifications', 'nBob'), { organizationId: 'orgB' }));       // move
  await assertFails(updateDoc(doc(as('bob'), 'notifications', 'nBob'), { title: 'edited', read: true }));  // rewrite content
  await assertFails(updateDoc(doc(as('alice'), 'notifications', 'nBob'), { read: true }));
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
  await assertSucceeds(setDoc(doc(root, 'regulations', 'reg1'), { name: 'GDPR', lastSyncedAt: serverTimestamp(), source: 'manual-seed' }, { merge: true }));   // syncRegulationDatabase()
  await assertSucceeds(setDoc(doc(root, 'regulations', 'reg2'), { name: 'DPDP' }));
  await assertFails(setDoc(doc(as('alice'), 'platformAdmins', 'alice'), { x: 1 }));                          // cannot self-grant
});

// ------------------------------------------------------------------ reserved / immutable fields
test('ownership fields are immutable on documents, reports, risk records, issues and organizations', async () => {
  const b = as('bob');
  await assertFails(updateDoc(doc(b, 'documents', 'docA'), { uploadedBy: 'alice' }));
  await assertFails(updateDoc(doc(b, 'documents', 'docA'), { uploadedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(b, 'complianceReports', 'repA'), { createdAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(b, 'riskAssessments', 'riskA'), { createdAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(b, 'complianceIssues', 'issA'), { documentId: 'other' }));
  await assertFails(updateDoc(doc(b, 'complianceIssues', 'issA'), { createdAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(b, 'organizations', 'orgA'), { plan: 'enterprise' }));                       // members cannot edit the org doc at all
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
  await assertFails(deleteDoc(doc(b, 'documents', 'docA')));            // delete = admin / compliance officer
  await assertFails(deleteDoc(doc(b, 'complianceReports', 'repA')));
  await assertFails(getDoc(doc(as('carol'), 'documents', 'dB')));       // isolation still holds
});
test('REGRESSION admin workflow: delete document/report, cancel invite, read audit logs, manage team', async () => {
  const a = as('alice');
  await assertSucceeds(deleteDoc(doc(a, 'documents', 'docA')));
  await assertSucceeds(deleteDoc(doc(a, 'complianceReports', 'repA')));
  await assertSucceeds(deleteDoc(doc(a, 'riskAssessments', 'riskA')));
  await assertFails(deleteDoc(doc(a, 'complianceIssues', 'issA')));     // issues are never deletable
  await assertSucceeds(updateDoc(doc(a, 'organizations', 'orgA'), { plan: 'pro' }));
  await assertSucceeds(getDoc(doc(a, 'users', 'bob')));
  await assertFails(getDoc(doc(a, 'users', 'gina')));
});
