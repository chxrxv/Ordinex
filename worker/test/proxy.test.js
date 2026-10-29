import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import * as w from '../src/index.js';

const subtle = webcrypto.subtle;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const NOW = 1_800_000_000;
let pair, jwk;

before(async () => {
  pair = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  jwk = { ...(await subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
});
beforeEach(() => w.resetJwksCache());

async function token(over = {}, { alg = 'RS256', kid = 'k1', key = () => pair.privateKey } = {}) {
  const payload = { aud: w.PROJECT_ID, iss: `https://securetoken.google.com/${w.PROJECT_ID}`, sub: 'user123', iat: NOW - 10, exp: NOW + 3000, ...over };
  const head = b64u(JSON.stringify({ alg, kid, typ: 'JWT' })), body = b64u(JSON.stringify(payload));
  const sig = await subtle.sign('RSASSA-PKCS1-v1_5', key(), new TextEncoder().encode(head + '.' + body));
  return `${head}.${body}.${b64u(sig)}`;
}
const jwksFetch = async (url) => ({ ok: true, status: 200, json: async () => ({ keys: [jwk] }) });
const verify = (t) => w.verifyIdToken(t, { fetchImpl: jwksFetch, now: NOW, subtle });
const rejects401 = (p) => assert.rejects(p, (e) => e.status === 401);

test('a correctly signed Firebase token for this project verifies', async () => {
  assert.equal((await verify(await token())).sub, 'user123');
});

test('forged, expired, mis-targeted and malformed tokens are all refused', async () => {
  await rejects401(verify(await token({ exp: NOW - 1 })));                                  // expired
  await rejects401(verify(await token({ aud: 'other-project' })));                          // wrong audience
  await rejects401(verify(await token({ iss: 'https://securetoken.google.com/other' })));   // wrong issuer
  await rejects401(verify(await token({ sub: '' })));                                       // no subject
  await rejects401(verify(await token({ iat: NOW + 9999 })));                               // issued in the future
  await rejects401(verify(await token({}, { kid: 'unknown' })));                            // unknown key id
  const other = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  await rejects401(verify(await token({}, { key: () => other.privateKey })));               // signed by someone else
  const good = await token(); const [h, p, s] = good.split('.');
  const tampered = `${h}.${b64u(JSON.stringify({ aud: w.PROJECT_ID, iss: `https://securetoken.google.com/${w.PROJECT_ID}`, sub: 'admin', iat: NOW - 10, exp: NOW + 3000 }))}.${s}`;
  await rejects401(verify(tampered));                                                       // payload swapped, signature kept
  await rejects401(verify(`${b64u(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${p}.`));    // alg:none
  await rejects401(verify(`${b64u(JSON.stringify({ alg: 'HS256', kid: 'k1' }))}.${p}.${s}`)); // HMAC confusion
  await rejects401(verify('not-a-token')); await rejects401(verify(undefined));
});

test('validateInput enforces sizes and image rules', () => {
  for (const bad of [null, {}, { prompt: '' }, { prompt: 5 }, { prompt: 'x'.repeat(w.LIMITS.prompt + 1) }, { prompt: 'x', systemInstruction: 'y'.repeat(w.LIMITS.system + 1) },
    { prompt: 'x', imageBase64: 'AAAA', imageMimeType: 'application/pdf' }, { prompt: 'x', imageBase64: '<script>', imageMimeType: 'image/png' }, { prompt: 'x', imageBase64: 'A'.repeat(w.LIMITS.image + 1), imageMimeType: 'image/png' }]) {
    assert.throws(() => w.validateInput(bad), (e) => e.status === 400);
  }
  const ok = w.validateInput({ prompt: 'p', jsonOutput: true, imageBase64: 'AAAA', imageMimeType: 'image/png' });
  assert.equal(ok.jsonOutput, true); assert.equal(ok.image.mimeType, 'image/png');
});

const memKv = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, m }; };

test('per-user and global daily caps; no KV binding fails closed', async () => {
  const kv = memKv();
  for (let i = 0; i < w.LIMITS.perUserDaily; i++) await w.checkQuota(kv, 'u1', new Date('2026-10-29T10:00:00Z'));
  await assert.rejects(w.checkQuota(kv, 'u1', new Date('2026-10-29T11:00:00Z')), (e) => e.status === 429 && /Daily AI limit/.test(e.message));
  await w.checkQuota(kv, 'u2', new Date('2026-10-29T11:00:00Z'));                                 // another user is unaffected
  await w.checkQuota(kv, 'u1', new Date('2026-10-30T00:00:01Z'));                                 // new day resets
  kv.m.set('g:2026-11-01', String(w.LIMITS.globalDaily));
  await assert.rejects(w.checkQuota(kv, 'u9', new Date('2026-11-01T00:00:00Z')), (e) => e.status === 429 && /shared free AI allowance/.test(e.message));
  await assert.rejects(w.checkQuota(undefined, 'u1'), (e) => e.status === 503);
});

// ---- full handler ----
const GOOD = { prompt: 'analyse this', jsonOutput: true };
function mkDeps({ org = 'orgA', gemini = 'hello' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith(w.JWKS_URL)) return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
    if (String(url).includes('firestore.googleapis.com')) return org ? { ok: true, status: 200, json: async () => ({ fields: { organizationId: { stringValue: org } } }) } : { ok: true, status: 200, json: async () => ({ fields: {} }) };
    if (String(url).includes('generativelanguage')) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: gemini }] } }] }) };
    throw new Error('unexpected fetch ' + url);
  };
  return { deps: { fetchImpl, now: NOW, subtle, nowDate: new Date('2026-10-29T10:00:00Z') }, calls };
}
const req = (body, headers = {}, method = 'POST', path = '/ai/generate') => new Request('https://ai.example.workers.dev' + path, { method, headers: { 'Content-Type': 'application/json', Origin: 'https://ordinex-862ba.web.app', ...headers }, body: method === 'POST' ? JSON.stringify(body) : undefined });
const env = () => ({ GEMINI_API_KEY: 'SECRET-KEY-VALUE', QUOTA: memKv() });

test('handler: happy path returns text, key goes in a header and never in the response', async () => {
  const { deps, calls } = mkDeps();
  const res = await w.handle(req(GOOD, { Authorization: 'Bearer ' + await token() }), env(), deps);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(JSON.parse(body).text, 'hello');
  assert.ok(!body.includes('SECRET-KEY-VALUE'));
  const g = calls.find((c) => c.url.includes('generativelanguage'));
  assert.equal(g.init.headers['x-goog-api-key'], 'SECRET-KEY-VALUE'); assert.ok(!g.url.includes('SECRET'));
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://ordinex-862ba.web.app');
});

test('handler: no token, bad token, foreign origin, non-member and missing secret are all refused before any Gemini call', async () => {
  const run = async (r, e = env(), d = mkDeps()) => { const res = await w.handle(r, e, d.deps); return { status: res.status, gemini: d.calls.some((c) => c.url.includes('generativelanguage')) }; };
  assert.deepEqual(await run(req(GOOD)), { status: 401, gemini: false });
  assert.deepEqual(await run(req(GOOD, { Authorization: 'Bearer junk' })), { status: 401, gemini: false });
  assert.deepEqual(await run(req(GOOD, { Authorization: 'Bearer ' + await token(), Origin: 'https://evil.example' })), { status: 403, gemini: false });
  assert.deepEqual(await run(req(GOOD, { Authorization: 'Bearer ' + await token() }), env(), mkDeps({ org: null })), { status: 403, gemini: false });
  assert.deepEqual(await run(req(GOOD, { Authorization: 'Bearer ' + await token() }), { QUOTA: memKv() }), { status: 503, gemini: false });
  assert.deepEqual(await run(req({ prompt: '' }, { Authorization: 'Bearer ' + await token() })), { status: 400, gemini: false });
});

test('handler: CORS preflight, health, unknown paths', async () => {
  const pre = await w.handle(req(null, { 'Access-Control-Request-Method': 'POST' }, 'OPTIONS'), env(), mkDeps().deps);
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'https://ordinex-862ba.web.app');
  const evil = await w.handle(req(null, { Origin: 'https://evil.example' }, 'OPTIONS'), env(), mkDeps().deps);
  assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await w.handle(req(null, {}, 'GET', '/health'), env(), mkDeps().deps)).status, 200);
  assert.equal((await w.handle(req(null, {}, 'GET', '/other'), env(), mkDeps().deps)).status, 404);
});
