# Deployment plan — security branch (`security/local-ai-hardening`)

**Status: prepared, NOT executed.** Nothing in this document has been run against production. Deploy only after you have reviewed the pull request and ticked the checklist below.

## 1. What a deployment changes

Command (explicit project, services limited):

```powershell
firebase deploy --only firestore:rules,hosting --project ordinex-862ba
```

| Service | Affected | Not affected |
|---|---|---|
| **Firestore rules** (`firestore.rules`) | Replaced in full. | No documents are read, written or migrated. `firestore.indexes.json` is **not** deployed and needs no change: the new invitation queries are single-field equality (`email ==`, `organizationId ==`) and use automatic indexes. |
| **Hosting** (`public/`) | Exactly these 7 files are published: `ordinex.html`, `local-assess.html`, `firestore-rest.js`, `vendor/docx.iife.js`, `vendor/mammoth.browser.min.js`, `vendor/pdf.min.js`, `vendor/pdf.worker.min.js`. The `ignore` list excludes dot-files and `node_modules`. | `.env`, `local-ai/**` (including `data/`), `rules-test/**`, `docs/**`, test fixtures, model files and `functions-optional-blaze-upgrade/**` live outside `public/` and cannot be published. |
| Authentication, Storage, Cloud Functions | — | Untouched. No paid service is enabled; nothing needs the Blaze plan. |

Verify the list yourself before deploying: `Get-ChildItem public -Recurse -File | Select FullName`.

### User-visible changes after deploying
- Hosted site: the embedded Gemini key is gone and cloud AI is off. AI features show "Local AI not connected" until a user runs the local backend (see `local-ai/README.md`).
- Invitations are now org-scoped documents (`invitations/{orgId}_{email}`). **Pending invitations created by the old version live in `organizations/*/invites` and will no longer appear in the Team list — re-send them.** (Rules keep read/delete on that legacy location so admins can clean up.)
- Organisation admins can rename their organisation but can no longer change plan/seats; only platform admins can (Admin Console).
- Shared regulations can only be updated by platform admins (see `docs/PLATFORM_ADMIN.md`).
- Bug fixed along the way: the **Admin Console** menu item was added once at page load, before platform-admin status was known, so platform admins never saw it in live mode. It is now evaluated on every render.
- No existing user, organisation, document, report or notification is modified. Existing organisations keep their current `plan`/`seats`.

## 2. Configuration restoration (do this first)

The committed `public/ordinex.html` contains **placeholders** for the Firebase web config (deliberately — the repository is public). Deploying it as committed would publish a broken site.

Choose one:

- **A. Deploy from your existing working copy** that already contains the real config. Before deploying, confirm: `Select-String -Path public\ordinex.html -Pattern 'projectId: "ordinex-862ba"'` finds one match, and `Select-String -Path public\ordinex.html -Pattern 'YOUR_PROJECT_ID'` finds none.
- **B. Deploy from a clean checkout:** copy `.env.example` to `.env`, fill the `FIREBASE_*` values (Firebase console → Project settings → Your apps), leave `GEMINI_*` empty, run `npm run configure`, then run the same two checks as in A. `.env` is git-ignored — never commit it. (Note the deploy script `npm run deploy` also runs `configure`.)

The Firebase web `apiKey` is a public client identifier by design; it is not a secret, but it still must not be replaced by any *other* key.

## 3. Pre-deployment checklist

- [ ] Pull request reviewed and the branch is the one you intend to deploy (`git rev-parse HEAD`).
- [ ] All suites green on that commit: `npm run ai:test`, `npm run ai:dataset`, `npm run rules:test`, `npm run ai:ui:test`, `npm run ai:ui:test:emulator` (and `npm run ai:ui:test:e2e` if Ollama is installed).
- [ ] Config restored and checked (section 2).
- [ ] **Back up the live rules:** Firebase console → Firestore → Rules → copy the full text into a dated file outside the repo (e.g. `backup-firestore-rules-YYYY-MM-DD.rules`). Repo history also holds the previous version (`git show e6bfd03:firestore.rules`) but the live copy is the authoritative backup.
- [ ] Note the current Hosting release (console → Hosting → release history) so you can roll back to it.
- [ ] Platform admin ready: `platformAdmins/{your UID}` created in the console (`docs/PLATFORM_ADMIN.md` §1). Safe to do before deploying.
- [ ] Decide regulation seeding order (`docs/PLATFORM_ADMIN.md` §2, Option A or B).
- [ ] Tell your users that pending invitations must be re-sent.
- [ ] The old Gemini key is revoked in Google AI Studio (removing it from the page does not invalidate it).
- [ ] `firebase use` shows `ordinex-862ba` (your account also has `ordinex-50b01`; the command above names the project explicitly).
- [ ] Working tree contains nothing you do not want published (`git status`, and the public file list above).

## 4. Deploy

Run the command in section 1 from the repository root. (`npm run deploy` / `scripts/deploy.sh` runs `configure` and then deploys `firestore:rules,firestore:indexes,hosting`; the indexes file is unchanged by this branch, so that is equivalent, but the explicit command above is the reviewed one.) Rules and hosting are deployed together; during the few seconds between them an old cached page may attempt the old invite path and get a permission error — a refresh fixes it.

## 5. Post-deployment smoke tests (real site: https://ordinex-862ba.web.app)

Use throw-away test accounts; do not use customer data.

1. **Landing page** loads; browser console shows no errors; the badge says "Local AI not connected" (expected without a local backend).
2. **Sign up** (email/password) with an organisation name → dashboard loads.
3. **Sign in with Google** → dashboard (or organisation onboarding if new).
4. **Upload a text-only test document** (AI analysis will report that local AI is not connected — expected on the hosted site).
5. **Team → Invite Member** with a second test address; the row shows "Invited".
6. In a private window: sign up as that address **with the organisation name empty** → "You've been invited" card → verify the email (link in the inbox) → "I've verified my email" → **Accept** → lands in the inviting organisation with the invited role, and the first user's Team list shows the new member.
7. **Settings → Billing → Upgrade:** as a normal admin there are *no* Select buttons and the text names the platform administrator.
8. **Knowledge Base:** normal admins do **not** see "Sync Regulation Database"; the platform admin does, and Sync succeeds.
9. **Admin Console** (platform admin): organisations listed; "Set plan" changes a test org's plan.
10. Firestore console → Usage/Rules monitoring: no unexpected spike of denied requests; browser console: no `permission-denied` during the steps above.
11. `https://ordinex-862ba.web.app/local-assess.html` loads and states that the website cannot run AI by itself.

If any step fails, stop and roll back (section 6) before investigating.

## 6. Rollback

- **Rules:** Firebase console → Firestore → Rules → paste the backed-up text → **Publish**. (Or restore the file from `git show e6bfd03:firestore.rules` and run `firebase deploy --only firestore:rules --project ordinex-862ba`.) Rule publishes take effect within about a minute. No data was changed by the deploy, so no data rollback is needed — except that invitations created *after* the deploy (new collection) are ignored by the old client.
- **Hosting:** console → Hosting → release history → **Rollback** on the previous release (instant), or redeploy the previous commit with config restored.
- **Both** may be rolled back independently; rolling back rules only restores the old (weaker) protections, so prefer fixing forward if the problem is only cosmetic.

## 7. Known limits to carry into production use

Hosted visitors still need a local install for AI; GDPR and DPDP source text is unverified; signed-in flows are tested against emulators with fake users, not against the live project; the HTTPS-hosted → local-backend connection is untested; organisation members can still resolve issues and create reports (documented product behaviour). Production use additionally needs monitoring, backup/restore, independent security testing and legal review of regulatory content.
