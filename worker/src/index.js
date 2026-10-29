/* Ordinex hosted-AI proxy: a free Cloudflare Worker (no paid plan, no Firebase Blaze).
   It lets signed-in Ordinex users get AI analysis WITHOUT bringing their own key:
   - the Gemini key lives only in the Worker secret GEMINI_API_KEY (never in the website or the repo)
   - the caller must present a valid Firebase ID token for THIS project (signature, issuer, audience, expiry verified here)
   - the caller must belong to an organisation (their own profile is read with their own token, so Firestore rules apply)
   - per-user and global daily caps protect the shared free quota (stored in KV; approximate by design)
   - CORS is limited to the Ordinex site origins
   See docs/FREE_HOSTED_AI.md for setup. */

export const PROJECT_ID = 'ordinex-862ba';
export const ALLOWED_ORIGINS = ['https://ordinex-862ba.web.app', 'https://ordinex-862ba.firebaseapp.com'];
export const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
export const MODEL = 'gemini-flash-lite-latest';
export const LIMITS = { prompt: 60000, system: 8000, image: 5000000, perUserDaily: 40, globalDaily: 800, outTokens: 2048 };

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- helpers ----------
const b64urlToBytes = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
};
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

export function corsHeaders(origin) {
  const h = { 'Vary': 'Origin' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

// ---------- Firebase ID token verification ----------
let jwksCache = { at: 0, keys: null };
export function resetJwksCache() { jwksCache = { at: 0, keys: null }; }
async function getJwks(fetchImpl, now) {
  if (jwksCache.keys && now - jwksCache.at < 3600) return jwksCache.keys;
  const res = await fetchImpl(JWKS_URL);
  if (!res.ok) throw new HttpError(503, 'Could not load Google signing keys.');
  const j = await res.json();
  if (!j || !Array.isArray(j.keys)) throw new HttpError(503, 'Unexpected signing key response.');
  jwksCache = { at: now, keys: j.keys };
  return j.keys;
}

export async function verifyIdToken(token, { fetchImpl = fetch, now = Math.floor(Date.now() / 1000), projectId = PROJECT_ID, subtle = crypto.subtle } = {}) {
  const bad = () => new HttpError(401, 'Sign in again: your session could not be verified.');
  if (typeof token !== 'string' || token.split('.').length !== 3) throw bad();
  const [h, p, s] = token.split('.');
  let header, payload;
  try { header = b64urlToJson(h); payload = b64urlToJson(p); } catch (e) { throw bad(); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw bad();      // never accept "none" or HMAC
  const jwk = (await getJwks(fetchImpl, now)).find((k) => k.kid === header.kid);
  if (!jwk) throw bad();
  let ok = false;
  try {
    const key = await subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    ok = await subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), new TextEncoder().encode(h + '.' + p));
  } catch (e) { ok = false; }
  if (!ok) throw bad();
  if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) throw bad();
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw bad();
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) throw bad();
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw bad();
  return payload;
}

// ---------- input, quota, Gemini ----------
export function validateInput(data) {
  const d = data && typeof data === 'object' ? data : {};
  if (typeof d.prompt !== 'string' || !d.prompt.trim()) throw new HttpError(400, 'A prompt is required.');
  if (d.prompt.length > LIMITS.prompt) throw new HttpError(400, `The prompt is too long (limit ${LIMITS.prompt} characters).`);
  const system = d.systemInstruction == null ? '' : d.systemInstruction;
  if (typeof system !== 'string' || system.length > LIMITS.system) throw new HttpError(400, 'Invalid system instruction.');
  let image = null;
  if (d.imageBase64 != null) {
    if (typeof d.imageBase64 !== 'string' || d.imageBase64.length > LIMITS.image || !/^[A-Za-z0-9+/=]+$/.test(d.imageBase64)) throw new HttpError(400, 'Invalid or oversized image.');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(d.imageMimeType)) throw new HttpError(400, 'Unsupported image type.');
    image = { data: d.imageBase64, mimeType: d.imageMimeType };
  }
  return { prompt: d.prompt, systemInstruction: system, jsonOutput: d.jsonOutput === true, image };
}

export async function checkQuota(kv, uid, now = new Date()) {
  if (!kv) throw new HttpError(503, 'The AI service is not fully configured yet.');
  const day = now.toISOString().slice(0, 10);
  const uKey = `u:${uid}:${day}`, gKey = `g:${day}`;
  const [u, g] = await Promise.all([kv.get(uKey), kv.get(gKey)]);
  const un = parseInt(u || '0', 10) || 0, gn = parseInt(g || '0', 10) || 0;
  if (gn >= LIMITS.globalDaily) throw new HttpError(429, 'The shared free AI allowance for today is used up. Try again tomorrow, or add your own free Gemini key in the AI badge.');
  if (un >= LIMITS.perUserDaily) throw new HttpError(429, `Daily AI limit reached (${LIMITS.perUserDaily} requests per user). Try again tomorrow.`);
  await Promise.all([kv.put(uKey, String(un + 1), { expirationTtl: 172800 }), kv.put(gKey, String(gn + 1), { expirationTtl: 172800 })]);
}

export function buildGeminiRequest({ prompt, systemInstruction, jsonOutput, image }) {
  const parts = [...(image ? [{ inlineData: { mimeType: image.mimeType, data: image.data } }] : []), { text: prompt }];
  const body = { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, maxOutputTokens: LIMITS.outTokens, ...(jsonOutput ? { responseMimeType: 'application/json' } : {}) } };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  return body;
}

export async function callGemini(apiKey, input, fetchImpl = fetch) {
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(buildGeminiRequest(input)),
  });
  if (res.status === 429) throw new HttpError(429, 'The AI provider is busy. Try again in a minute.');
  if (!res.ok) throw new HttpError(502, `The AI provider returned an error (${res.status}).`);
  const j = await res.json().catch(() => null);
  const c = j && j.candidates && j.candidates[0];
  const text = c && c.content && Array.isArray(c.content.parts) ? c.content.parts.map((x) => x.text || '').join('') : '';
  if (!text.trim()) throw new HttpError(502, 'The model returned no answer; nothing was generated.');
  return text;
}

// The signed-in user reads THEIR OWN profile with THEIR token, so Firestore rules apply (no service account needed).
export async function requireOrgMember(uid, idToken, fetchImpl = fetch) {
  const res = await fetchImpl(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}`, { headers: { Authorization: 'Bearer ' + idToken } });
  if (!res.ok) throw new HttpError(403, 'Your profile could not be read. Finish setting up your organisation first.');
  const j = await res.json().catch(() => null);
  const org = j && j.fields && j.fields.organizationId && j.fields.organizationId.stringValue;
  if (!org) throw new HttpError(403, 'Join or create an organisation to use AI analysis.');
}

// ---------- request handler ----------
export async function handle(request, env, deps = {}) {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin);
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
  const url = new URL(request.url);
  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health' && request.method === 'GET') return json(200, { ok: true, service: 'ordinex-ai', model: MODEL });
    if (url.pathname !== '/ai/generate' || request.method !== 'POST') throw new HttpError(404, 'Not found.');
    if (origin && !ALLOWED_ORIGINS.includes(origin)) throw new HttpError(403, 'This origin is not allowed.');
    const m = /^Bearer (.+)$/.exec(request.headers.get('Authorization') || '');
    if (!m) throw new HttpError(401, 'Sign in to use AI analysis.');
    const claims = await verifyIdToken(m[1], { fetchImpl: deps.fetchImpl || fetch, now: deps.now, subtle: deps.subtle || crypto.subtle });
    const input = validateInput(await request.json().catch(() => null));
    if (!env.GEMINI_API_KEY) throw new HttpError(503, 'The AI service is not fully configured yet.');
    await requireOrgMember(claims.sub, m[1], deps.fetchImpl || fetch);
    await checkQuota(env.QUOTA, claims.sub, deps.nowDate || new Date());
    return json(200, { text: await callGemini(env.GEMINI_API_KEY, input, deps.fetchImpl || fetch) });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: { message: e.message } });
    console.error('ai proxy failure:', e && e.message ? String(e.message).slice(0, 160) : 'unknown');
    return json(500, { error: { message: 'AI analysis failed unexpectedly.' } });
  }
}

export default { fetch: (request, env) => handle(request, env) };
