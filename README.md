# Ordinex

AI-assisted regulatory compliance and risk intelligence. Upload company documents, tag a jurisdiction, and get a gap analysis checked against retrieved regulatory provisions, with evidence passages, deterministic risk scores and a reproducible report.

**AI runs on your own computer** (Ollama + `qwen3:4b`). No paid AI API, no API key, and no document is sent to a cloud model. The website itself is static and cannot run AI — see [Architecture](#architecture).

> **Status: demo / review stage, not production.** Regulatory text is a small, partly unverified paraphrase dataset; findings are model-assisted and need human review; this is not legal advice. See [Limitations](#limitations).

## Architecture

| Part | What it is | Where it runs |
|---|---|---|
| Web app | `public/ordinex.html` (single-file vanilla JS app: auth, org/team, documents, reports) and `public/local-assess.html` (standalone assessment page) | Firebase Hosting (`ordinex-862ba.web.app`) or your own machine |
| Auth + data | Firebase Authentication and Firestore, protected only by `firestore.rules` | Firebase (free Spark plan, no Cloud Functions) |
| Local AI backend | `local-ai/` — Node server: document ingestion, SQLite FTS5 retrieval, Ollama calls, evidence validation, deterministic risk scoring, reports | **Your computer**, bound to `127.0.0.1:8787` |
| Model | `qwen3:4b` through Ollama (Apache-2.0), GPU if available, CPU fallback | **Your computer** |

**The hosted site cannot run AI by itself.** On a visitor's machine `127.0.0.1` is the visitor's own computer, and Firebase Hosting cannot run Ollama. So a visitor needs Ollama + this backend installed locally for AI features; otherwise the hosted site works but every AI surface shows "not connected" in red and nothing is fabricated. A hosted AI for arbitrary visitors would need an always-on GPU/CPU host (Cloud Functions/Run require the paid Blaze plan), so it is intentionally not built.

Two ways to use AI (details in [`local-ai/README.md`](./local-ai/README.md)):

1. **Fully local (recommended):** `npm run ai`, open `http://127.0.0.1:8787/` or `…/local-assess.html`. Nothing is exposed.
2. **Hosted page + your local backend (explicit opt-in):** start the backend with `ORDINEX_ALLOWED_ORIGINS=https://ordinex-862ba.web.app`, then use **Connect** (only loopback addresses are accepted). The allowed origin can then read your local assessments, so allow only origins you trust.

Local assessments are stored as JSON in `local-ai/data/` on your machine (git-ignored). They are **separate from Firestore**; the Firebase dashboard never receives assessment contents unless you build and consent to that.

## How the analysis works

Document ingestion (PDF/DOCX/TXT, page/paragraph references; scanned and encrypted PDFs are rejected, not guessed) → regulatory retrieval (jurisdiction filter + BM25) → the local model compares one provision with up to three excerpts and cites **chunk + sentence numbers** → application code resolves the citations to real document text, downgrades any verdict without a verified citation, flags prompt-injection text, and computes risk with a fixed formula → hash-checked snapshot → Markdown / HTML / JSON reports. The existing `evidence-model.js` traceability checks (source → provision → obligation → evidence → finding → risk → remediation) still run. The model never sets a score, URL, deadline or "verified" flag.

## Features

- Jurisdiction-aware document analysis with evidence passages and human-review flags
- Deterministic, documented risk scoring (`local-ai/src/risk.js`)
- Regulation comparison, searchable knowledge base, risk assessment, alerts, reports (the main app's report export uses client-side libraries; it was not browser-tested in the latest security review)
- Team management with roles (Admin, Compliance Officer, Analyst, User) and **email-verified, expiring, single-use, atomically accepted invitations**
- Firebase Authentication (email/password and Google) and real-time Firestore data

## Regulatory data verification status

`local-ai/regdata/regulations.json` is a seed set (5 GDPR articles, 3 India DPDP Act sections, 3 HIPAA provisions). All provision text is the authors' **paraphrase**, never official wording.

| Regulation | Source check |
|---|---|
| HIPAA | **verified** against the official eCFR (2026-10-29): headings, 60-day limit, "addressable" encryption, "required" risk analysis |
| GDPR | **unverified** — the EUR-Lex fetch returned no content |
| DPDP Act | **unverified** — the MeitY site returned HTTP 403 |

Findings from unverified sources are always flagged for human review; `lastVerified` stays empty until every regulation is verified. Validate the file with `npm run ai:dataset`. Effective dates, amendment tracking and licence/reuse checks are **not** done.

## Getting started (Windows)

Prerequisites: Node.js ≥ 22.5, [Ollama](https://ollama.com), the Firebase CLI for deployment.

```powershell
git clone https://github.com/chxrxv/Ordinex.git ; cd Ordinex      # or your checkout
ollama pull qwen3:4b
cd local-ai ; npm install ; cd ..
npm run ai:doctor        # hardware / model check
npm run ai               # http://127.0.0.1:8787/
```

Reference hardware used in testing: RTX 4050 6 GB, ~3.9 GB VRAM at 8k context, about 10–15 s per analysed provision. CPU-only speed is untested.

### Firebase configuration

The committed `public/ordinex.html` contains **placeholders** for the Firebase web config. Copy `.env.example` to `.env`, fill in the Firebase values (the Gemini variables are only for the optional, off-by-default legacy cloud path and can stay empty), and run `npm run configure` before serving or deploying. Never commit `.env`.

## Tests

```powershell
npm run ai:test            # backend unit tests
npm run ai:dataset         # regulatory dataset validator
npm run rules:test         # Firestore rules (43 tests incl. security-audit probes), against the Firebase emulator (needs Java; cd rules-test ; npm install)
npm run ai:ui:test:emulator # the REAL signed-in app (sign-up, org, invitations, billing, regulations, an XSS regression) + REST-helper hardening tests, against the Auth + Firestore emulators
npm run ai:ui:test         # browser + API tests: real Chromium, real backend, MOCK Ollama
npm run ai:ui:test:e2e     # real browser -> backend -> real Ollama qwen3:4b (needs the model installed)
npm run ai:eval            # real-model evaluation on 10 synthetic cases
node --test functions-optional-blaze-upgrade/test/evidence-model.test.js
```

One-time: `cd local-ai ; npx playwright install chromium`. Mock-model tests exercise UI and failure paths only; they are not evidence of AI quality. The 10-case evaluation is synthetic and says nothing about real-world legal accuracy. The emulator suite drives the real app with a fake `demo-ordinex` Firebase project (never the real one) and fails if any request would reach a real Google/Firebase API host. It covers sign-up, organisation creation, inviting, verifying and accepting, stale-rejoin refusal, billing, shared regulations and the platform-admin path — **not** every signed-in screen (documents, reports, risk, chat, etc. are untested in a browser).

## Security model

- Firestore rules are the only server-side authorization. They enforce organisation isolation, role boundaries, immutable ownership fields, and member-only notification delivery. Shared `regulations` are **read-only for every organisation user; only a platform admin** (a document you create in `platformAdmins/{uid}` in the Firebase console) may write them, and the "Sync Regulation Database" button is shown only to them.
- Invitations: `invitations/{organizationId}_{lowercased email}` (the id embeds the org, so one org can never touch another's invitations). Created by an org admin (≤ 15-day expiry). Accepting and joining happen in **one atomic Firestore commit** (REST `documents:commit` via `public/firestore-rest.js`, because the bundled SDK has no batch API) and the rules require both writes together, so an invitation is single-use, cannot be half-applied, and cannot be replayed by a removed member. The invitee's email must be verified.
- The local backend binds to loopback, checks the `Host` header, refuses non-loopback or non-allow-listed `Origin`s on `/api`, caps upload size, and never serves files outside `public/`.
- No AI key is embedded in the frontend. If a Gemini key was ever deployed, revoke it in Google AI Studio — removing it from code does not invalidate it.
- Identifiers: document/report/risk/issue/notification ids must match `[A-Za-z0-9_-]{1,64}`, organisation ids `[A-Za-z0-9]{1,64}`, and invitation emails a conservative character set (enforced by the rules). The UI additionally renders ids into inline handlers only through `jsq()`, because HTML-escaping is not sufficient inside `onclick` attributes. A previous audit demonstrated stored XSS from a member to an admin via a crafted document id; both layers close it.
- Organisation bootstrap: a user may promote themselves to admin of an organisation they created only within 10 minutes of creating it, so a founder who is later removed cannot walk back in.
- Users with no organisation cannot create organisation data or send notifications.
- Billing fields: organisation admins may only rename their organisation; `plan`/`seats` can be changed only by a platform admin (Admin Console → Set plan). New organisations always start as `starter`/5 seats. There is no payment provider.
- Platform admin bootstrap and regulation seeding: see [`docs/PLATFORM_ADMIN.md`](./docs/PLATFORM_ADMIN.md). Deployment plan, backup and rollback: [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).
- Known trade-offs: any organisation member can resolve issues and create reports (documented product behaviour); members of an organisation can send each other notifications.

## Deployment

See [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) (checklist, exact files and services, backup, rollback, smoke tests). In short: run the tests, run `npm run configure`, then `firebase deploy --only firestore:rules,hosting --project ordinex-862ba`. Deploy only from a tree where the Firebase config has been injected, otherwise the site will contain placeholders.

## Project structure

```
ord/
├── public/
│   ├── ordinex.html            # the main application (single file)
│   ├── local-assess.html       # standalone local-AI assessment page
│   └── vendor/                 # pdf.js, mammoth, docx (bundled)
├── local-ai/                   # local backend, tests, evaluation (see its README)
├── rules-test/                 # Firestore rules tests (emulator)
├── docs/                       # PLATFORM_ADMIN.md, DEPLOYMENT.md
├── firestore.rules             # the entire backend's access control
├── firestore.indexes.json
├── functions-optional-blaze-upgrade/  # dormant Cloud Functions path + evidence-model.js and tests
├── scripts/                    # configure.js, deploy.sh
├── firebase.json  .env.example
└── SETUP.md                    # original setup notes (predates the local-AI architecture; the Gemini sections are outdated)
```

## Limitations

- AI is local-only; hosted visitors need a local install. No OCR (scanned PDFs are rejected). No translation (non-English documents are flagged for human review).
- Regulatory dataset is small, paraphrased, and mostly unverified (above). Model output can be wrong; evidence checks confirm that a cited passage exists, not that it legally satisfies a provision.
- Signed-in app flows, the HTTPS-hosted → local connection, and non-Chromium browsers have not been tested.

## License

This project is for educational and portfolio purposes. Model weights keep their own licences (`qwen3:4b`: Apache-2.0).
