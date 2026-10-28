'use strict';
// Unit tests for public/firestore-rest.js (the atomic-commit helper the app uses for invitation acceptance).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const rest = require('../../public/firestore-rest.js');

test('encodeValue: supported types; unsupported types and non-finite numbers are refused', () => {
  assert.deepEqual(rest.encodeValue(null), { nullValue: null });
  assert.deepEqual(rest.encodeValue('x'), { stringValue: 'x' });
  assert.deepEqual(rest.encodeValue(true), { booleanValue: true });
  assert.deepEqual(rest.encodeValue(5), { integerValue: '5' });
  assert.deepEqual(rest.encodeValue(2.5), { doubleValue: 2.5 });
  assert.deepEqual(rest.encodeValue(new Date('2026-01-02T03:04:05.000Z')), { timestampValue: '2026-01-02T03:04:05.000Z' });
  assert.throws(() => rest.encodeValue({}), /Unsupported/);
  assert.throws(() => rest.encodeValue(undefined), /Unsupported/);
  assert.throws(() => rest.encodeValue(NaN), /non-finite/);
});

test('buildCommit: field masks, server timestamps, must-exist precondition, project path', () => {
  const c = rest.buildCommit('p1', [
    { path: 'invitations/o_a@b.io', fields: { status: 'accepted', acceptedBy: 'u1' }, serverTimestamps: ['acceptedAt'] },
    { path: 'users/u1', fields: { organizationId: 'o', role: 'analyst' } },
  ]);
  assert.equal(c.writes.length, 2);
  const w = c.writes[0];
  assert.equal(w.update.name, 'projects/p1/databases/(default)/documents/invitations/o_a@b.io');
  assert.deepEqual(w.updateMask.fieldPaths, ['status', 'acceptedBy']);          // only these fields change; acceptedAt comes from the transform
  assert.deepEqual(w.updateTransforms, [{ fieldPath: 'acceptedAt', setToServerValue: 'REQUEST_TIME' }]);
  assert.deepEqual(w.currentDocument, { exists: true });                         // update-only: never creates documents
  assert.equal(c.writes[1].updateTransforms, undefined);
});

test('buildCommit: rejects bad input', () => {
  assert.throws(() => rest.buildCommit('', [{ path: 'a/b' }]), /projectId/);
  assert.throws(() => rest.buildCommit('p', []), /At least one/);
  assert.throws(() => rest.buildCommit('p', [{ path: 'users' }]), /Invalid document path/);       // collection, not a document
  assert.throws(() => rest.buildCommit('p', [{ path: '../users/x' }]), /Invalid document path|Invalid/);
  assert.throws(() => rest.buildCommit('p', [{ path: 'a/b/c' }]), /Invalid document path/);       // odd segment count
});

test('commit: sends one atomic POST with the bearer token; maps Firestore errors to SDK-style codes', async () => {
  let seen;
  const ok = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ writeResults: [{}, {}] }) }; };
  const out = await rest.commit({ projectId: 'p1', idToken: 'tok', writes: [{ path: 'users/u1', fields: { role: 'user' } }], fetchImpl: ok, baseUrl: 'http://127.0.0.1:8081/' });
  assert.equal(seen.url, 'http://127.0.0.1:8081/v1/projects/p1/databases/(default)/documents:commit');
  assert.equal(seen.init.method, 'POST'); assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.equal(out.writeResults.length, 2);
  const denied = async () => ({ ok: false, status: 403, json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } }) });
  await assert.rejects(rest.commit({ projectId: 'p1', idToken: 't', writes: [{ path: 'users/u1', fields: {} }], fetchImpl: denied }), (e) => e.code === 'permission-denied' && e.status === 403);
  const garbage = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
  await assert.rejects(rest.commit({ projectId: 'p1', idToken: 't', writes: [{ path: 'users/u1', fields: {} }], fetchImpl: garbage }), /HTTP 502/);
  await assert.rejects(rest.commit({ projectId: 'p1', writes: [{ path: 'users/u1', fields: {} }], fetchImpl: ok }), /signed-in user/);
});
