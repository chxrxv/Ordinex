# Ordinex local AI engine

Zero-cost, fully local compliance analysis for Ordinex. Inference runs on your own machine through [Ollama](https://ollama.com). No API key, no subscription, no cloud model.

```
Browser (public/ordinex.html)  ──same origin──▶  local-ai/src/server.js  ──▶  Ollama (127.0.0.1:11434)  ──▶  qwen3:4b on your GPU/CPU
                                                   │ documents.js   PDF / DOCX / TXT extraction + chunking (page / paragraph refs)
                                                   │ retrieval.js   SQLite FTS5 (BM25): provisions + document evidence
                                                   │ pipeline.js    per-obligation: retrieve → model (JSON schema) → validate → risk → remediation
                                                   │ validate.js    quote/ID verification, downgrade rules, prompt-injection redaction
                                                   │ risk.js        deterministic scoring (formula in the file header)
                                                   └ report.js      Markdown/HTML/JSON reports from hash-checked snapshots
```

## Model

| | |
|---|---|
| Primary | `qwen3:4b` (Q4_K_M, 4.0B params, 2.5 GB download) |
| Licence | **Apache-2.0** — the licence text shipped inside the Ollama package for this exact tag (`ollama show qwen3:4b --license`). Re-check if you pull a different tag or derivative. |
| Measured here | RTX 4050 Laptop 6 GB: loads 100 % on GPU, ~3.9 GB VRAM at `num_ctx` 8192, ~10–15 s per analysed provision (cold first call is slower) |
| Alternative | `llama3.2:1b` (already common on laptops; much weaker) or `qwen3:1.7b` if VRAM < 4 GB; `qwen3:8b` / `14b` only with ≥ 8 / 12 GB VRAM (not tested here) |
| Not tested | CPU-only speed (expect several × slower; works, since Ollama falls back automatically) |

Change model with `OLLAMA_MODEL` in `local-ai/.env`. Never auto-downloaded by the app.

## Windows setup (exact commands)

```powershell
# 1. Ollama (skip if `ollama --version` works)
winget install Ollama.Ollama
ollama pull qwen3:4b

# 2. Node.js >= 22.5 (needs the built-in node:sqlite).  Verified with Node 24.
node -v

# 3. Dependencies (mammoth BSD-2, pdfjs-dist Apache-2.0)
cd ord\local-ai
npm install
cd ..

# 4. Check hardware / model / inference
npm run ai:doctor

# 5. Start Ordinex + backend, then open the UI
npm run ai
#   → http://127.0.0.1:8787/
```

Open the app **through that URL** (the backend serves `public/ordinex.html` and the API on one origin). A badge in the bottom-right shows `Local AI: qwen3:4b (GPU)` or an honest "AI analysis unavailable" message; the app still loads without Ollama.

Optional config: copy `local-ai/.env.example` to `local-ai/.env` (git-ignored). Variables: `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_NUM_CTX`, `OLLAMA_TIMEOUT_MS`, `OLLAMA_TEMPERATURE`, `PORT`, `MAX_UPLOAD_MB`.

## Hosting architecture (read this first)

* **Firebase Hosting** (`https://ordinex-862ba.web.app`, directory `ord/public`) serves only static files: the app, `local-assess.html`, and vendored libraries. It **cannot run Ollama or any AI**, and it cannot reach your computer: on a visitor's machine `127.0.0.1` is *their own* machine.
* **A visitor can therefore NOT use AI without installing local software** (Ollama + `qwen3:4b` + this backend, `npm run ai`). Without it, the hosted site loads and works as before, and every AI surface says "not connected" in red; nothing is fabricated.
* **Mode A — fully local (recommended, no setting needed):** run `npm run ai`, open `http://127.0.0.1:8787/`. Same origin, nothing exposed.
* **Mode A2 — hosted page + your local backend (explicit opt-in):** start the backend with `ORDINEX_ALLOWED_ORIGINS=https://ordinex-862ba.web.app` (PowerShell: `$env:ORDINEX_ALLOWED_ORIGINS="https://ordinex-862ba.web.app"; npm run ai`), open the hosted page, click **Connect** (Local Assessment page) or the red badge (main app). Only loopback addresses are accepted by the page, so documents can never be sent to a remote server. Security trade-off: the allowed origin (and any script running on it) can read your local assessments, so only allow origins you trust. Chrome/Edge may show a "local network access" permission prompt for an HTTPS page calling loopback; Firefox/Safari may block it. This HTTPS→loopback path was tested only with an HTTP stand-in origin, not on the real hosted site.
* **Mode B — public AI for arbitrary visitors with no install: not implemented, deliberately.** It needs an always-on GPU/CPU host running an open-weight model. Firebase Hosting cannot do it; Cloud Functions/Cloud Run need the paid Blaze plan; free tiers cannot hold a 4B model; a public endpoint also needs abuse controls. No honest zero-cost option exists for unlimited visitors, so it is documented as a limitation rather than faked.
* The backend always binds to 127.0.0.1, checks the `Host` header, and refuses any `/api` request whose `Origin` is not loopback or explicitly allow-listed (HTTP 403).

## Regulatory dataset status

Run `npm run ai:dataset` (validator: required fields, duplicate IDs, https/official hosts, and that no entry claims verification without date, method, version and scope). Current honest state (checked 2026-10-29):

| Regulation | Source check | Notes |
|---|---|---|
| HIPAA (3 provisions) | **verified-official** (eCFR, as of 2025-01-01) | Existence, headings, 60-day limit, "addressable" encryption, "required" risk analysis. Wording is still a paraphrase. |
| GDPR (5 articles) | **unverified** | EUR-Lex returned empty content; no comparison possible. |
| DPDP Act (3 sections) | **unverified** | MeitY returned HTTP 403. |

All provision text is `textBasis: paraphrase`, every finding from an unverified source is flagged for human review, `lastVerified` stays `null` until every regulation is verified, and reports/UI show the status per finding. Effective-date and amendment tracking and reuse-licence confirmation are **not** done (the `reuseStatus` fields say so).

## Firestore rules

`firestore.rules` was audited and tightened (see `rules-test/`): a new user could create their own profile as admin of any org, and any signed-in user could overwrite another org's reports/risk records or re-assign documents, notifications and chats. `npm run rules:test` runs 10 tests against the Firestore emulator (needs Java + `cd rules-test; npm install`); the original rules fail 5 of them, the new rules pass all 10. **The fixed rules are not live until you run `firebase deploy --only firestore:rules`.** The main app's login/dashboard flows themselves were not tested (no Firebase emulator hook exists in the app, and I did not add one).

## Using it from the browser

Two entry points, both served by `npm run ai` on http://127.0.0.1:8787/:

* **`/local-assess.html` — Local Assessment page (works with no Firebase).** Choose PDF/DOCX/TXT files, pick jurisdiction and data types, click **Analyze**. Shows progress, a **Cancel** button, findings with verified evidence passages and risk scores, remediation suggestions, limitations, saved assessments, and downloads (Markdown / HTML / JSON). Deep link: `/local-assess.html#asm-xxxxxxxxxx`. There is no PDF/DOCX export. A second analysis cannot start while one is running (HTTP 409), so double clicks never create duplicates. This page is the validated, snapshot-based view.
* **`/` — the existing Ordinex app.** It is a Firebase SPA: everything behind login needs a real Firebase account and was **not** browser-tested here. Its landing/registration pages load without errors. A status badge and a "Local assessment" link are injected on every page.

## Using it from the existing app (Firebase mode)

Upload a document in Ordinex (live Firebase mode) with a country tag. The existing upload flow now calls the local pipeline: text → `/api/documents` → `/api/analyze` → validated findings are mapped into the existing gap list. Click the badge afterwards to open the full validated report (sources, evidence quotes, risk, remediation, limitations, model and dataset info). Chat, summaries and report text in the existing UI also go to the local model. Cloud Gemini is **off** (`geminiConfig.allowCloud: false`); it can only be re-enabled deliberately (`GEMINI_ALLOW_CLOUD=true` + key in `.env`, then `npm run configure`).

API: `GET /api/health`, `GET /api/regulations`, `GET /api/regulations/search?q=&jurisdictions=`, `POST /api/documents` (raw body + `X-Filename`), `POST /api/analyze {profile, documentIds}` → `jobId`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`, `GET /api/assessments[/:id[/report?format=md|html|json]]`.

Company profile fields used: `jurisdictions` (`EU`, `IN`, `US`), `dataTypes` (`personal`, `health`, …), `dataSubjects`. A UI form for the full profile is **not built**; the upload flow derives jurisdiction from the country tag and adds `health` if the text mentions patients/ePHI.

## How findings are made reliable

* Obligations come from the regulation dataset, filtered by jurisdiction and data type in code; "not applicable" always carries a reason.
* Evidence is retrieved with FTS5/BM25 from the document's own chunks. **No matching passage → "Insufficient evidence" without calling the model** (absence of evidence is never "non-compliant").
* The model gets one provision + ≤ 3 excerpts, constrained to a JSON schema (Ollama `format`), thinking disabled, temperature 0.1. Every excerpt sentence is numbered (`[C1.2]`).
* **Citations are by reference, not by copy.** The model returns `{chunkId, sentence}`; the application resolves it against the real chunk and builds the quote from the document text itself. (Earlier versions asked the model to copy a quote; qwen3:4b under constrained decoding repeatedly corrupted digits, e.g. "72" → "7:2", so valid evidence was rejected. Legacy `quote` citations are still accepted but must match the chunk text.) Unknown chunk IDs, out-of-range sentence numbers, and citing a redacted/instruction-like sentence are refused and flagged. An unresolvable citation is retried twice with a stricter hint before the verdict is **downgraded** to Insufficient evidence and flagged. A Compliant / Partial / Non-compliant verdict with no resolved citation is always downgraded. The model cannot mark anything "verified", set a score, a URL or a deadline.
* Document text is untrusted: instruction-like sentences are removed before prompting, the chunk is flagged for review, and a **Compliant verdict that rests on a document containing injection text is withheld**.
* Non-English documents are flagged for human review; original text is never replaced by a translation. No translation is performed.
* The existing `evidence-model.js` (`validateTraceabilityGraph`) checks Source → Provision → Obligation → Evidence → Finding → Risk → Remediation, plus finding↔risk and source↔provision consistency. Reports refuse to render if the snapshot hash does not match.
* Risk = `round(100 × likelihood(status) × (0.5·severity/5 + 0.3·penaltyExposure/5 + 0.2·dataSensitivity/5))`; High ≥ 60, Medium 30–59, Low < 30. Weights are author assumptions, uncalibrated. Insufficient-evidence risks are marked `uncertain`. Timelines are labelled "suggested internal target"; only `statutoryDeadline` values from the dataset are shown as deadlines.

## Regulatory dataset — read this

`regdata/regulations.json` is a **small seed set**: 5 GDPR articles, 3 India DPDP Act sections, 3 HIPAA provisions. The `obligation` text is a **paraphrase written by the authors of this change from memory, not official text, and has not been verified or lawyer-reviewed**; `lastVerified` is `null` on purpose. Source URLs point to the official instruments, but were not re-checked by a crawler. It is **not a live feed**. To extend: add entries with the same schema (per provision `id, ref, title, severity 1-5, obligation, evidenceTerms[], ownerRole, verification[]`), restart, and set `lastVerified` only after checking the official text.

## Tests and evaluation

```powershell
# from ordnpm run ai:test           # 32 backend unit tests (model output stubbed ONLY here, to test validation logic)
npm run ai:ui:test        # 46 browser + API tests: real Chromium, real backend, MOCK Ollama (~2 min, no model needed)
npm run ai:ui:test:headed # same, with a visible browser
npm run ai:ui:test:e2e    # 1 real test: browser -> backend -> real Ollama qwen3:4b (~20-30 s warm)
npm run ai:eval           # real model against 10 synthetic cases + 6 retrieval queries -> eval/results/latest.json
```

One-time browser setup (Playwright is a free dev dependency; Chromium is a ~170 MB download): `cd local-ai; npx playwright install chromium`. Tests use isolated temp data directories and never touch `local-ai/data/`. Failure traces/screenshots go to `%TEMP%\ordinex-ui-test-results`. The mock Ollama lives in `ui-test/helpers/env.js` and is used only by the `*.fast` / `*.api` specs; the e2e spec uses none and records Ollama's own token counters and GPU/CPU placement.

Measured on this machine (qwen3:4b, RTX 4050 6 GB), `eval/results/run3.json` (after the sentence-citation change; run 2 was identical):

| Metric | Result |
|---|---|
| Acceptable-status accuracy | 10 / 10 |
| Strict (single best answer) accuracy | 9 / 10 (`breach-vague`: model said Non-compliant, label was Partially compliant) |
| Citation validity (quotes verified in source) | 10 / 10 |
| Unsupported-claim rate (cited evidence failed verification) | 0 / 10 |
| Injection cases ending "Compliant" | 0 / 2 |
| Retrieval hit@1 / hit@3 (provision search) | 5/6 / 6/6 |
| Mean latency per single-provision assessment | ~14.9 s |

**Caveat:** run 1 on the same cases scored 8/10 (one injection case wrongly Compliant, one false rejection of a valid quote) and exposed a 948 s stall; the validator/policy fixes were made after seeing those failures, so run 2 is **not** an independent test. n = 10 toy documents with author-assigned labels says nothing about real-world legal accuracy.

## What works / partial / missing

* **Works (tested):** local inference on GPU; TXT/PDF/DOCX ingestion with page/paragraph refs; empty/malformed/unsupported/oversize/binary detection; scanned-PDF detection; FTS5 retrieval; validated findings; deterministic risk; remediation with suggested owner/priority/timeline; traceability validation; hash-checked reports (MD/HTML/JSON); honest model-down behaviour; path-traversal protection on uploads and static files.
* **Partial:** UI integration is through the existing upload/analysis flow, chat and report text, plus a status badge and report link — the dashboard widgets, risk register and remediation tracker still render Firestore data written by that flow (severity, recommendation, score = 100 − overall risk), not the full snapshot. No company-profile form. No PDF/DOCX export from the backend (reports are Markdown/HTML/JSON; print HTML to PDF in the browser). Password-protected PDF detection relies on pdf.js's `PasswordException` and was **not** tested with a real encrypted file.
* **Not built:** OCR (scanned PDFs and images are rejected with a clear message, never silently "analysed"); translation; semantic/vector retrieval; live regulatory updates; Firestore persistence of assessments (they are stored as JSON in `local-ai/data/`, git-ignored); multi-user auth on the backend (it binds to 127.0.0.1 only).
* **Needs human review:** all regulatory text and every finding. Not legal advice.

## Dependencies

| Package | Purpose | Licence |
|---|---|---|
| Ollama (external) | local model runtime | MIT |
| qwen3:4b | model weights | Apache-2.0 |
| mammoth | DOCX text | BSD-2-Clause |
| pdfjs-dist 4.10 | PDF text | Apache-2.0 |
| node:sqlite (built in) | FTS5 index | — |

Nothing downloaded (weights, `node_modules`, `data/`, eval results) is committed (see `.gitignore`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Badge red: "Ollama not running" | Start the Ollama app / `ollama serve`; `curl http://127.0.0.1:11434/api/version` |
| "model … not installed" | `ollama pull qwen3:4b` |
| Backend not running badge | `npm run ai`, open `http://127.0.0.1:8787/` (not the file or Firebase URL) |
| `node:sqlite` missing | Upgrade Node to ≥ 22.5 |
| Is the GPU used? | `ollama ps` → PROCESSOR column should say `100% GPU`; `npm run ai:doctor` |
| CPU only / slow | Update the NVIDIA driver; close GPU-heavy apps; lower `OLLAMA_NUM_CTX` (e.g. 4096) or use a smaller model; first call after idle includes model load time |
| Out of memory | Smaller model (`qwen3:1.7b`), `OLLAMA_NUM_CTX=4096`; the API reports `out-of-memory` explicitly |
| Timeouts | Raise `OLLAMA_TIMEOUT_MS`; first request loads the model |
| Download stalls | Re-run `ollama pull qwen3:4b` (resumes) |
| "needs-ocr" | The PDF is scanned; OCR is not available — supply a text PDF/DOCX |
| Port in use | `PORT=8788 npm run ai` |
