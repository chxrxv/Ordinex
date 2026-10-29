# Hosted AI (Cloud Function + Gemini)

The live website cannot reach a backend on a visitor's computer. To give every signed-in user AI analysis with no local
setup, `functions/` contains ONE callable function, `aiGenerate`, that proxies to Gemini.

## What it does and does not do
- Requires sign-in and membership of an organisation. Per-user limit: 60 requests per day (`aiUsage` counters, which no
  client can read or write). `maxInstances: 3` caps concurrency and worst-case spend.
- The Gemini key lives only in the `GEMINI_API_KEY` secret. It is sent in a header, never in a URL, and never logged.
- **Privacy:** when active, document text is sent to Google Gemini. The Security & Audit and System Status pages say so.
  Users with a local backend connected keep using it and their text stays on their computer.
- Hosted analysis uses the prompt-based pipeline. The local pipeline's retrieval, citation and deterministic risk scoring
  need the local backend, so hosted results are model-estimated and need human review. Image OCR is not supported.
- It costs money: Blaze is pay-as-you-go. Set a budget alert in Google Cloud Billing before enabling it.

## One-time setup (manual steps are yours)
1. Upgrade the Firebase project to **Blaze** (console -> Usage and billing) and set a budget alert.
2. Create a NEW Gemini API key in Google AI Studio (the old ones were deleted). Restrict it to the Generative Language API.
3. Store it as a secret (you paste it; it is never written to the repo):
   `firebase functions:secrets:set GEMINI_API_KEY --project ordinex-862ba`
4. Install and test: `cd functions && npm install && npm test`
5. Deploy ONLY the function: `firebase deploy --only functions:aiGenerate --project ordinex-862ba`
6. In `public/ordinex.html` set `hostedAI.enabled = true`, run the tests, commit, then deploy Hosting:
   `firebase deploy --only hosting --project ordinex-862ba`
7. Open System Status: "Cloud AI" should read Operational ("deployed and answering").

## Rollback
Set `hostedAI.enabled = false` and redeploy Hosting (instant), or delete the function:
`firebase functions:delete aiGenerate --region us-central1 --project ordinex-862ba`.
