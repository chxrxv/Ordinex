# Free hosted AI with NO key for users (Cloudflare Worker proxy)

Firebase's own server option (Cloud Functions) needs the paid Blaze plan. A free Cloudflare Worker (`worker/`) does the same job:
it holds ONE Gemini key privately and answers only signed-in Ordinex members. Users add nothing.

## How it protects the shared key
- The key exists only as the Worker secret `GEMINI_API_KEY`. It is never in the website, the repo or the browser.
- Every request needs a valid Firebase ID token for `ordinex-862ba` (signature, issuer, audience, expiry verified in the Worker).
- The caller must belong to an organisation (their own profile is read with their own token, so Firestore rules apply).
- Limits: 40 requests per user per day, 800 per day overall (KV counters; approximate by design). CORS only for the Ordinex site.
- Everything fails closed: missing secret, missing KV binding, bad token or foreign origin means no Gemini call.

## Honest trade-offs
- Document text goes to Google Gemini. Free-tier content may be used by Google to improve its products. Do not use this for
  confidential material; connect the local backend instead. The Security & Audit page and the setup dialog say so.
- The free Gemini quota is shared by all users; when it is used up users see a clear message and can add their own key.
- Results are model-estimated and need human review (the local backend adds citations and the deterministic risk score).

## One-time setup (you, ~10 minutes; no card needed for Cloudflare Workers free plan)
1. Create a free account at dash.cloudflare.com.
2. `cd worker` then `npx wrangler login` (opens your browser).
3. `npx wrangler kv namespace create QUOTA` and paste the printed `id` into `worker/wrangler.toml`.
4. Create a NEW Gemini key in Google AI Studio (a dedicated one), then `npx wrangler secret put GEMINI_API_KEY` and paste it at the prompt.
5. `npx wrangler deploy`. It prints `https://ordinex-ai.<your-subdomain>.workers.dev`.
6. Send that URL to the assistant (or set `hostedAIProxy.url` in `public/ordinex.html` yourself), run the tests, deploy Hosting.
7. System Status then shows "Hosted AI service: Operational".

## Rollback
Set `hostedAIProxy.url = ''` and redeploy Hosting (users fall back to the own-key/local options), or `npx wrangler delete`.

## Tests
`cd worker && npm test` forges tokens (expired, wrong audience, tampered, `alg:none`, HMAC confusion, unknown key) and checks quotas, CORS and that the key never appears in a response. The browser flow is covered by `local-ai/ui-test/honest-product.emu.spec.js`.
