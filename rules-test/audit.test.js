'use strict';
// Final-audit probes. Each test asserts the SECURE behaviour; a failure against the rules = a confirmed finding.
// Runs against the Firestore emulator only (demo project).
const { test, before, after, beforeEach } = require('node:test');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, serverTimestamp, Timestamp, writeBatch } = require('firebase/firestore');
const fs = require('node:fs');
const path = require('node:path');

let env;
const [HOST, PORT] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8081').split(':');
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-ordinex-audit', firestore: { host: HOST, port: Number(PORT), rules: fs.readFileSync(process.env.RULES_FILE || path.join(__dirname, '..', 'firestore.rules'), 'utf8') } });
});
after(async () => { await env.cleanup(); });
const inDays = (n) => Timestamp.fromMillis(Date.now() + n * 864e5);
const ago = (min) => Timestamp.fromMillis(Date.now() - min * 60000);
const EMAIL = { alice: 'alice@a.io', bob: 'bob@a.io', mal: 'mal@evil.io', vic: 'vic@abc.io', dave: 'dave@x.io', erin: 'erin@x.io', zed: 'zed@x.io' };
const as = (uid, claims = {}) => env.authenticatedContext(uid, { email: EMAIL[uid], email_verified: true, ...claims }).firestore();
const inv = (org, email) => `${org}_${email}`;
const newInvite = (org, email, over = {}) => ({ email, organizationId: org, organizationName: org, role: 'user', invitedBy: 'x', status: 'pending', createdAt: serverTimestamp(), expiresAt: inDays(7), ...over });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const u = (uid, org, role) => setDoc(doc(db, 'users', uid), { uid, organizationId: org, role, email: EMAIL[uid] || null });
    await Promise.all([
      // orgA was created by alice (founder); bob is a second admin.
      u('alice', 'orgA', 'admin'), u('bob', 'orgA', 'admin'),
      // victim org "abc", attacker org "abc_bob" (an org id containing an underscore)
      u('vic', 'abc', 'admin'), u('mal', 'abc_bob', 'admin'),
      u('dave', null, null), u('erin', null, null), u('zed', null, null),
      setDoc(doc(db, 'organizations', 'orgA'), { name: 'A', createdBy: 'alice', plan: 'starter', seats: 5, createdAt: ago(60 * 24 * 30) }),
      setDoc(doc(db, 'organizations', 'abc'), { name: 'abc', createdBy: 'vic', plan: 'starter', seats: 5, createdAt: ago(60 * 24) }),
      setDoc(doc(db, 'organizations', 'abc_bob'), { name: 'evil', createdBy: 'mal', plan: 'starter', seats: 5, createdAt: ago(60 * 24) }),
    ]);
  });
});

test('F1: a removed FOUNDER cannot re-promote themselves to admin of the org they once created', async () => {
  // bob (another admin) removes alice, the founder (createdBy == alice) - removeMember() does exactly this write.
  await assertSucceeds(updateDoc(doc(as('bob'), 'users', 'alice'), { organizationId: null, role: null }));
  // the bootstrap rule must not let her walk back in (org created long ago)
  await assertFails(updateDoc(doc(as('alice'), 'users', 'alice'), { organizationId: 'orgA', role: 'admin' }));
});

test('F1b: the legitimate bootstrap (fresh user, org created moments ago) still works - exact app sequence', async () => {
  const db = as('founder1');                         // brand-new uid, no profile yet
  await assertSucceeds(setDoc(doc(db, 'users', 'founder1'), { uid: 'founder1', email: 'f@x.io', displayName: 'f', photoURL: null, role: null, organizationId: null, createdAt: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(db, 'organizations', 'fresh1'), { name: 'F', createdBy: 'founder1', plan: 'starter', seats: 5, createdAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, 'users', 'founder1'), { organizationId: 'fresh1', role: 'admin' }));
  await assertSucceeds(addDoc(collection(db, 'auditLogs'), { organizationId: 'fresh1', actorUid: 'founder1', action: 'Organization created', target: 'F', status: 'success', timestamp: serverTimestamp() }));
});

test('F1c: bootstrap cannot be used on someone else org, nor on an org the caller created long ago', async () => {
  await assertFails(updateDoc(doc(as('dave'), 'users', 'dave'), { organizationId: 'orgA', role: 'admin' }));    // not creator
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'organizations', 'oldOwn'), { name: 'O', createdBy: 'erin', plan: 'starter', seats: 5, createdAt: ago(60) }); });
  await assertFails(updateDoc(doc(as('erin'), 'users', 'erin'), { organizationId: 'oldOwn', role: 'admin' }));  // creator, but 60 min ago
});

test('F2: invitation-id collision - an org whose id contains "_" cannot squat another org\'s invitation ids', async () => {
  // victim "abc" wants to invite bob_smith@x.io  -> id "abc_bob_smith@x.io".
  // attacker org "abc_bob" + email "smith@x.io"  -> the SAME id.
  const squat = setDoc(doc(as('mal'), 'invitations', 'abc_bob_smith@x.io'), newInvite('abc_bob', 'smith@x.io', { invitedBy: 'mal' }));
  await assertFails(squat);
  // and the victim's legitimate invitation must work
  await assertSucceeds(setDoc(doc(as('vic'), 'invitations', 'abc_bob_smith@x.io'), newInvite('abc', 'bob_smith@x.io', { invitedBy: 'vic' })));
});

test('F2b: organisation ids must be plain alphanumerics (no "_" / separators) so invitation ids are unambiguous', async () => {
  const db = as('dave');
  await assertFails(setDoc(doc(db, 'organizations', 'x_y'), { name: 'N', createdBy: 'dave', plan: 'starter', seats: 5, createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(db, 'organizations', 'a@b.c'), { name: 'N', createdBy: 'dave', plan: 'starter', seats: 5, createdAt: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(db, 'organizations', 'AbC123xyz'), { name: 'N', createdBy: 'dave', plan: 'starter', seats: 5, createdAt: serverTimestamp() }));
});

test('F3: users with NO organisation cannot send notifications to other org-less users (null == null)', async () => {
  const n = { userId: 'erin', organizationId: null, title: 'Your account is locked - click here', body: 'x', level: 'Critical', read: false, createdAt: serverTimestamp() };
  await assertFails(addDoc(collection(as('dave'), 'notifications'), n));
});

test('F4: users with NO organisation cannot create org-less documents, reports, risk records, issues or audit logs', async () => {
  const d = as('dave');
  await assertFails(setDoc(doc(d, 'documents', 'junk'), { organizationId: null, uploadedBy: 'dave', name: 'x' }));
  await assertFails(addDoc(collection(d, 'complianceReports'), { organizationId: null, title: 'x' }));
  await assertFails(addDoc(collection(d, 'riskAssessments'), { organizationId: null, score: 1 }));
  await assertFails(addDoc(collection(d, 'complianceIssues'), { organizationId: null, title: 'x' }));
  await assertFails(addDoc(collection(d, 'auditLogs'), { organizationId: null, actorUid: 'dave', action: 'x' }));
});

test('F5: organisation creation is allow-listed (no arbitrary extra fields, a real name, a real createdAt)', async () => {
  const d = as('dave');
  const base = { name: 'N', createdBy: 'dave', plan: 'starter', seats: 5, createdAt: serverTimestamp() };
  await assertFails(setDoc(doc(d, 'organizations', 'o1x'), { ...base, isPlatform: true }));
  await assertFails(setDoc(doc(d, 'organizations', 'o2x'), { ...base, name: '' }));
  await assertFails(setDoc(doc(d, 'organizations', 'o3x'), { ...base, name: 'x'.repeat(500) }));
  await assertFails(setDoc(doc(d, 'organizations', 'o4x'), { ...base, createdAt: Timestamp.fromMillis(Date.now() - 864e5) }));   // forged old date
  await assertSucceeds(setDoc(doc(d, 'organizations', 'o5x'), base));
});

test('F6: invitation payload is validated (organizationName is a bounded string)', async () => {
  const a = as('alice');
  await assertFails(setDoc(doc(a, 'invitations', inv('orgA', 'p@x.io')), newInvite('orgA', 'p@x.io', { invitedBy: 'alice', organizationName: 'x'.repeat(5000) })));
  await assertFails(setDoc(doc(a, 'invitations', inv('orgA', 'q@x.io')), newInvite('orgA', 'q@x.io', { invitedBy: 'alice', organizationName: { nested: 1 } })));
  await assertSucceeds(setDoc(doc(a, 'invitations', inv('orgA', 'r@x.io')), newInvite('orgA', 'r@x.io', { invitedBy: 'alice', organizationName: 'A' })));
});

test('F7: CONCURRENT acceptance - two simultaneous accept+join commits result in exactly one success and one membership', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'invitations', inv('orgA', EMAIL.erin)), { email: EMAIL.erin, organizationId: 'orgA', organizationName: 'A', role: 'analyst', invitedBy: 'alice', status: 'pending', createdAt: ago(5), expiresAt: inDays(7) });
  });
  const e = as('erin');
  const attempt = () => { const b = writeBatch(e); b.update(doc(e, 'invitations', inv('orgA', EMAIL.erin)), { status: 'accepted', acceptedBy: 'erin', acceptedAt: serverTimestamp() }); b.update(doc(e, 'users', 'erin'), { organizationId: 'orgA', role: 'analyst' }); return b.commit(); };
  const results = await Promise.allSettled(Array.from({ length: 6 }, attempt));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  // Firestore may apply identical no-op retries as successes only if state is unchanged; the invariant that matters:
  let userOrg, status;
  await env.withSecurityRulesDisabled(async (ctx) => {
    userOrg = (await getDoc(doc(ctx.firestore(), 'users', 'erin'))).data().organizationId;
    status = (await getDoc(doc(ctx.firestore(), 'invitations', inv('orgA', EMAIL.erin)))).data().status;
  });
  if (ok !== 1) throw new Error(`expected exactly 1 successful commit, got ${ok}`);
  if (userOrg !== 'orgA' || status !== 'accepted') throw new Error('final state wrong: ' + userOrg + '/' + status);
});

test('F8: partial-failure atomicity with a THIRD write - an extra write to someone else\'s document sinks the whole commit', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'invitations', inv('orgA', EMAIL.erin)), { email: EMAIL.erin, organizationId: 'orgA', organizationName: 'A', role: 'analyst', invitedBy: 'alice', status: 'pending', createdAt: ago(5), expiresAt: inDays(7) });
  });
  const e = as('erin');
  const b = writeBatch(e);
  b.update(doc(e, 'invitations', inv('orgA', EMAIL.erin)), { status: 'accepted', acceptedBy: 'erin', acceptedAt: serverTimestamp() });
  b.update(doc(e, 'users', 'erin'), { organizationId: 'orgA', role: 'analyst' });
  b.update(doc(e, 'users', 'alice'), { role: 'user' });                                         // piggy-backed escalation attempt
  await assertFails(b.commit());
  let userOrg; await env.withSecurityRulesDisabled(async (ctx) => { userOrg = (await getDoc(doc(ctx.firestore(), 'users', 'erin'))).data().organizationId; });
  if (userOrg !== null) throw new Error('membership was created despite the failed commit');
});

test('INFO: unverified-email holder can read an invitation addressed to their address (disclosure only, cannot accept)', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'invitations', inv('orgA', EMAIL.erin)), { email: EMAIL.erin, organizationId: 'orgA', organizationName: 'A', role: 'admin', invitedBy: 'alice', status: 'pending', createdAt: ago(5), expiresAt: inDays(7) });
  });
  const unv = env.authenticatedContext('erin', { email: EMAIL.erin, email_verified: false }).firestore();
  await assertSucceeds(getDoc(doc(unv, 'invitations', inv('orgA', EMAIL.erin))));         // documented: reveals org name + role
  const b = writeBatch(unv);
  b.update(doc(unv, 'invitations', inv('orgA', EMAIL.erin)), { status: 'accepted', acceptedBy: 'erin', acceptedAt: serverTimestamp() });
  b.update(doc(unv, 'users', 'erin'), { organizationId: 'orgA', role: 'admin' });
  await assertFails(b.commit());
});

test('F9: the profile allow-list stays STRICT - re-writing a whole existing profile (what a duplicate sign-up write does) is refused, first-time creation still works', async () => {
  const db = as('dupuser');
  const full = () => ({ uid: 'dupuser', email: 'dup@x.io', displayName: 'dup', photoURL: null, role: null, organizationId: null, createdAt: serverTimestamp() });
  await assertSucceeds(setDoc(doc(db, 'users', 'dupuser'), full()));         // the single intended creation
  await assertFails(setDoc(doc(db, 'users', 'dupuser'), full()));            // a second full write = update that rewrites createdAt/uid/email
  await assertFails(updateDoc(doc(db, 'users', 'dupuser'), { createdAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, 'users', 'dupuser'), { displayName: 'renamed' }));   // legitimate profile edit unaffected
});

// ---- auditLogs shape pinning (added with the Security & Audit page) ----
test('auditLogs create: forged timestamp, extra fields, bad status and oversized strings are refused', async () => {
  const ok = { organizationId: 'orgA', actorUid: 'bob', action: 'x', target: 'y', status: 'success', timestamp: serverTimestamp() };
  const b = as('bob');
  await assertSucceeds(addDoc(collection(b, 'auditLogs'), ok));
  await assertFails(addDoc(collection(b, 'auditLogs'), { ...ok, timestamp: new Date('2020-01-01') }));
  await assertFails(addDoc(collection(b, 'auditLogs'), { ...ok, extra: 'smuggled' }));
  await assertFails(addDoc(collection(b, 'auditLogs'), { ...ok, status: 'pwned' }));
  await assertFails(addDoc(collection(b, 'auditLogs'), { ...ok, action: 'a'.repeat(201) }));
  await assertFails(addDoc(collection(b, 'auditLogs'), { ...ok, target: 't'.repeat(301) }));
  const { timestamp, ...noTs } = ok;
  await assertFails(addDoc(collection(b, 'auditLogs'), noTs));
});

test('remediation: owner must be a member of the issue\'s own org; status and due date are validated', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'complianceIssues', 'iss1'), { organizationId: 'orgA', documentId: 'd1', title: 't', severity: 'High', status: 'Open', createdAt: ago(5) });
  });
  const ref = doc(as('bob'), 'complianceIssues', 'iss1');
  await assertSucceeds(updateDoc(ref, { status: 'In Progress', assigneeId: 'alice', dueDate: '2026-12-31' }));   // alice is in orgA
  await assertSucceeds(updateDoc(ref, { assigneeId: null, dueDate: null }));                                      // clearing is fine
  await assertFails(updateDoc(ref, { assigneeId: 'vic' }));                 // member of ANOTHER org
  await assertFails(updateDoc(ref, { assigneeId: 'nobody-here' }));         // no such user
  await assertFails(updateDoc(ref, { status: 'Done-ish' }));
  await assertFails(updateDoc(ref, { dueDate: 'next tuesday' }));
  await assertFails(updateDoc(ref, { dueDate: 20261231 }));
  await assertFails(updateDoc(doc(as('mal'), 'complianceIssues', 'iss1'), { status: 'Resolved' }));              // other tenant
});
