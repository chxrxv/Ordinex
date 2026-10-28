# Platform admin bootstrap and regulation seeding

Some operations affect **every organisation** and therefore cannot be done by an organisation admin:

| Operation | Why it is platform-only |
|---|---|
| Writing the shared `regulations` collection ("Sync Regulation Database") | Every tenant reads it |
| Changing an organisation's `plan` / `seats` (Admin Console → "Set plan") | Billing fields; there is no payment backend |
| Reading all organisations and users (Admin Console) | Cross-tenant visibility |

A **platform admin** is simply a user who has a document at `platformAdmins/{their Firebase UID}`. Firestore rules deny every client read and write to that collection (`allow read, write: if false`), so **nobody can grant it from the app, including existing admins** — only someone with Firebase console (or Admin SDK) access to the project can. This document describes how to do that safely. Nothing here is automated, and nothing in this repository creates privileged production documents.

## 1. Bootstrap the first platform admin (manual, one time)

You need Owner/Editor access to the Firebase project (`ordinex-862ba`).

1. **Use a dedicated account.** Sign up in the Ordinex app with an email you control (ideally not the same login you use for day-to-day customer work) and complete email verification. Keep MFA on for the Google account that owns the Firebase project.
2. Open the Firebase console → **Authentication → Users** and copy that user's **User UID**. *Do not guess or reuse a UID from elsewhere.*
3. Firebase console → **Firestore Database → Data** → *Start collection* (first time) or open `platformAdmins` → **Add document**:
   - **Document ID:** the UID from step 2 (paste it; do not use "Auto-ID").
   - **Fields:** anything harmless, e.g. `note` (string) = `bootstrap admin, <date>`. The rules only test that the document *exists*.
4. In the app, sign out and in again. Verify:
   - the **Admin Console** entry appears in the sidebar;
   - **Knowledge Base** shows **Sync Regulation Database**.
5. Keep the list short (one or two people). To revoke someone, delete their `platformAdmins/{uid}` document; access ends at their next request.

What a platform admin can do: read every organisation and user, write shared regulations, change any organisation's plan/seats. It does **not** bypass organisation isolation for documents, reports or notifications.

## 2. Seed the shared regulations (manual, after step 1)

The collection `regulations` is read by every signed-in user and written only by platform admins.

1. Signed in as the platform admin, open **Knowledge Base → Sync Regulation Database**.
2. The app writes the fixed list `REGULATION_SEED_SET` that ships inside `public/ordinex.html` (currently 10 sample regulations: GDPR, CCPA, SOX, PCI-DSS, PIPL, MAS, PIPEDA, Australia Privacy Act, France LIL, India DPDP; each tagged `source: 'manual-seed'`). The operation is idempotent (`merge`): re-running it updates the same documents.
3. Check in the console: Firestore → `regulations` should contain those documents, each with `lastSyncedAt`.

**Content caveat — read before relying on it.** The seeded entries are the application's own **sample/reference data**. They are *not* the verified dataset used by the local AI backend (`local-ai/regdata/regulations.json`), they are not official legal text, and they must not be presented as authoritative. To publish reviewed content instead, replace `REGULATION_SEED_SET` with entries you have verified against official sources, keep the same fields, and run the sync again. Record the verification date/method; the local dataset's `sourceCheck` block is a good template.

### Migration note (important for the first deploy)

Until the new rules are deployed, **any organisation admin** can still run Sync (that was the old behaviour). After deployment only platform admins can. So either:

- **Option A (recommended):** create your `platformAdmins/{uid}` document *first* (step 1 is safe at any time — the old rules also deny client access to that collection), deploy, then run the sync as platform admin; or
- **Option B:** run the sync once as an organisation admin *before* deploying, then deploy.

If you do neither, the `regulations` collection keeps whatever it already contains; nothing is deleted, it just can no longer be refreshed by organisation admins.

## 3. Changing a plan or seat limit

Admin Console → organisation table → **Set plan** (platform admin only). Rules accept only `plan ∈ {starter, professional, enterprise}` and an integer `seats` between 1 and 1000, and only `plan`/`seats` may change in that write. Organisation admins can still rename their organisation and nothing else; new organisations are always created as `starter` with 5 seats. No payment is collected — this is an operator action, not a billing system.

## 4. Rehearsing safely

- Rules and the full invitation/billing/regulation flows are exercised against the **Firebase emulators** (`npm run rules:test`, `npm run ai:ui:test:emulator`), using a fake `demo-ordinex` project and fake users. Use those to rehearse behaviour; do not rehearse against production.
- Never put real credentials, UIDs of other people, or production exports into this repository or into test fixtures.
