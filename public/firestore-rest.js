/* Minimal Firestore REST "commit" helper for Ordinex.
 *
 * Why this exists: the Firebase SDK bundled into ordinex.html has no writeBatch()/runTransaction(), but accepting
 * an invitation MUST be atomic (mark the invitation accepted AND join the organisation, or neither). The Firestore
 * REST API's `documents:commit` is atomic, is evaluated by the SAME security rules (including getAfter()), and uses
 * the signed-in user's own ID token. Nothing here bypasses authentication or rules.
 *
 * Supported: updating EXISTING documents with a field mask (mustExist), plus server-timestamp transforms.
 * Values: null, boolean, integer, double, string, Date (-> timestamp). That is all the app needs.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrdinexFirestoreRest = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function encodeValue(v) {
    if (v === null) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'number') {
      if (!isFinite(v)) throw new Error('Cannot encode non-finite number');
      return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    }
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    throw new Error('Unsupported value type for Firestore REST commit: ' + typeof v);
  }

  /** write = { path, fields?, serverTimestamps?, mustExist? }  ->  REST Write object */
  function buildWrite(projectId, w) {
    if (!w || typeof w.path !== 'string' || !/^[^/]+(\/[^/]+)*$/.test(w.path) || w.path.split('/').length % 2 !== 0) {
      throw new Error('Invalid document path: ' + (w && w.path));
    }
    var fields = w.fields || {};
    var names = Object.keys(fields);
    var out = {
      update: { name: 'projects/' + projectId + '/databases/(default)/documents/' + w.path, fields: {} },
      updateMask: { fieldPaths: names.slice() },
    };
    names.forEach(function (k) { out.update.fields[k] = encodeValue(fields[k]); });
    if (w.serverTimestamps && w.serverTimestamps.length) {
      out.updateTransforms = w.serverTimestamps.map(function (f) { return { fieldPath: f, setToServerValue: 'REQUEST_TIME' }; });
    }
    if (w.mustExist !== false) out.currentDocument = { exists: true };
    return out;
  }

  function buildCommit(projectId, writes) {
    if (!projectId) throw new Error('projectId is required');
    if (!Array.isArray(writes) || !writes.length) throw new Error('At least one write is required');
    return { writes: writes.map(function (w) { return buildWrite(projectId, w); }) };
  }

  /** Atomically commits all writes with the caller's ID token. Rejects with err.code === 'permission-denied' etc. */
  function commit(opts) {
    var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) return Promise.reject(new Error('fetch is not available'));
    if (!opts.idToken) return Promise.reject(new Error('A signed-in user is required'));
    var base = (opts.baseUrl || 'https://firestore.googleapis.com').replace(/\/$/, '');
    var body;
    try { body = JSON.stringify(buildCommit(opts.projectId, opts.writes)); } catch (e) { return Promise.reject(e); }
    return fetchImpl(base + '/v1/projects/' + encodeURIComponent(opts.projectId) + '/databases/(default)/documents:commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.idToken },
      body: body,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (res.ok) return j;
        var st = (j && j.error && j.error.status) || '';
        var err = new Error((j && j.error && j.error.message) || ('Firestore commit failed (HTTP ' + res.status + ')'));
        err.code = st === 'PERMISSION_DENIED' ? 'permission-denied' : st === 'NOT_FOUND' ? 'not-found' : st === 'FAILED_PRECONDITION' ? 'failed-precondition' : st.toLowerCase().replace(/_/g, '-') || 'unknown';
        err.status = res.status;
        throw err;
      });
    });
  }

  return { encodeValue: encodeValue, buildWrite: buildWrite, buildCommit: buildCommit, commit: commit };
});
