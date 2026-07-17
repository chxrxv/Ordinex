/**
 * ORDINEX — Cloud Functions (2nd gen)
 * ============================================================
 * This is the real backend: Firebase Auth triggers, Firestore-backed
 * services, Storage-triggered document processing, and Gemini-backed
 * AI services (compliance analysis, risk assessment, report generation,
 * and the AI assistant chat).
 *
 * SETUP (see ../SETUP.md for the full walkthrough):
 *   1. cd functions && npm install
 *   2. firebase functions:secrets:set GEMINI_API_KEY
 *   3. firebase deploy --only functions
 *
 * Get a Gemini API key at https://aistudio.google.com/apikey
 * Verify the current model name there too — model names change over
 * time, so GEMINI_MODEL / GEMINI_MODEL_FAST below are configurable
 * rather than hardcoded assumptions.
 * ============================================================
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { defineSecret } = require('firebase-functions/params');
const functionsV1 = require('firebase-functions/v1');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');

admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();
// NOTE: admin.storage().bucket() is resolved lazily inside
// onDocumentUploaded() rather than here at module load time —
// calling it eagerly means any bucket-config issue would prevent
// ALL functions in this file from loading, not just this one.

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

// Configurable model names — check https://aistudio.google.com for current
// model IDs available to your API key before deploying.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const GEMINI_MODEL_FAST = process.env.GEMINI_MODEL_FAST || 'gemini-flash-lite-latest';
const GEMINI_EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';

/* ============================================================
   SHARED HELPERS
   ============================================================ */

/**
 * Gets a real embedding vector for a piece of text via Gemini's embedding
 * API. This is what makes RAG in chatWithAssistant "real" retrieval
 * instead of "last 5 documents" — no separate vector database (ChromaDB,
 * Pinecone, etc.) needs to be deployed; the vectors are just stored as a
 * float array field on each document and compared with plain cosine
 * similarity in cosineSimilarity() below. That's brute-force, not an
 * indexed ANN search, so it's the right call for tens-to-low-hundreds of
 * documents per org, not millions — see the note in chatWithAssistant.
 */
async function embedText(text) {
  const apiKey = GEMINI_API_KEY.value();
  if (!apiKey) throw new HttpsError('failed-precondition', 'GEMINI_API_KEY secret is not configured. See SETUP.md.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 8000) }] } }),
  });
  if (!res.ok) {
    const errText = await res.text();
    logger.error('Gemini embedding API error', { status: res.status, errText });
    return null; // embedding is an enhancement, not a hard requirement — callers fall back gracefully
  }
  const json = await res.json();
  return json.embedding?.values || null;
}

/** Pure, side-effect-free: standard cosine similarity between two equal-
 * length numeric vectors. Returns 0 for mismatched/missing input rather
 * than throwing, so a document with no embedding just sorts last instead
 * of crashing retrieval for the whole org. See functions/test/analysis.test.js. */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i]; }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Pure, side-effect-free: parses a JSON string, returning `fallback` (with
 * rawResponse attached) if parsing fails. Gemini is asked for JSON output
 * but LLMs occasionally wrap it in prose or markdown fences regardless, so
 * every call site needs this same fallback — pulled out once so it has
 * one real, tested implementation instead of three copies that could drift.
 * See functions/test/analysis.test.js. */
function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return { ...fallback, rawResponse: raw };
  }
}

/** Pure, side-effect-free: validates an email address is at least
 * plausibly well-formed. Deliberately permissive (this is a UX sanity
 * check, not the source of truth for deliverability) — see
 * functions/test/analysis.test.js. */
function isPlausibleEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Pure, side-effect-free: given a list of past request timestamps (ms)
 * and a window, returns whether a new request is allowed and how many ms
 * until the oldest one ages out if not. No Firestore/network involved —
 * see functions/test/analysis.test.js. */
function checkRateWindow(recentTimestamps, now, windowMs, maxRequests) {
  const inWindow = (recentTimestamps || []).filter((t) => now - t < windowMs);
  if (inWindow.length < maxRequests) {
    return { allowed: true, timestamps: [...inWindow, now] };
  }
  const oldest = Math.min(...inWindow);
  return { allowed: false, retryAfterMs: windowMs - (now - oldest), timestamps: inWindow };
}

/**
 * Firestore-backed rate limit for expensive (Gemini-calling) callable
 * functions. Not a full production rate limiter (Cloud Armor / App Check
 * would enforce this before the function even runs, at the network edge)
 * but a real, working per-user cap that costs nothing extra to deploy —
 * no new infrastructure, just a small doc per user+function.
 */
async function enforceRateLimit(uid, bucket, { maxRequests, windowMs }) {
  const ref = db.collection('rateLimits').doc(`${uid}_${bucket}`);
  const snap = await ref.get();
  const now = Date.now();
  const result = checkRateWindow(snap.exists ? snap.data().timestamps : [], now, windowMs, maxRequests);
  if (!result.allowed) {
    const seconds = Math.ceil(result.retryAfterMs / 1000);
    throw new HttpsError('resource-exhausted', `Too many requests — try again in ${seconds}s.`);
  }
  await ref.set({ timestamps: result.timestamps }, { merge: true });
}

function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to call this function.');
  }
  return request.auth;
}

async function requireOrgMembership(uid) {
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists || !userSnap.data().organizationId) {
    throw new HttpsError('failed-precondition', 'You must belong to an organization to do this.');
  }
  return userSnap.data();
}

async function writeAuditLog({ organizationId, actorUid, action, target, status = 'success', metadata = {} }) {
  await db.collection('auditLogs').add({
    organizationId,
    actorUid,
    action,
    target,
    status,
    metadata,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Minimal Gemini REST wrapper. No SDK dependency — plain fetch against
 * the public Generative Language API, matching Google's documented
 * request/response shape as of this writing.
 */
async function callGemini({ prompt, systemInstruction, model = GEMINI_MODEL, jsonOutput = false, imageBuffer = null, imageMimeType = null }) {
  const apiKey = GEMINI_API_KEY.value();
  if (!apiKey) {
    throw new HttpsError('failed-precondition', 'GEMINI_API_KEY secret is not configured. See SETUP.md.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const parts = [{ text: prompt }];
  if (imageBuffer && imageMimeType) {
    parts.unshift({ inlineData: { mimeType: imageMimeType, data: imageBuffer.toString('base64') } });
  }

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 2048,
      ...(jsonOutput ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    logger.error('Gemini API error', { status: res.status, errText });
    throw new HttpsError('internal', `AI service error (${res.status}). Check GEMINI_MODEL is valid for your API key.`);
  }

  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) {
    logger.warn('Gemini returned no text', { json });
  }
  return text;
}

/** Best-effort text extraction. PDFs and DOCX are parsed with well-known
 * libraries; images (scans/photos) are transcribed via Gemini's vision
 * capability — no separate OCR service or API needs to be enabled, it
 * reuses the same GEMINI_API_KEY secret already configured for analysis.
 * Anything else is treated as plain text. */
async function extractText(buffer, contentType, fileName) {
  try {
    if (contentType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      return data.text;
    }
    if (
      contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      fileName.toLowerCase().endsWith('.docx')
    ) {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    const lowerName = fileName.toLowerCase();
    const looksLikeImage = IMAGE_TYPES.includes(contentType) || /\.(jpe?g|png|webp|heic|heif)$/.test(lowerName);
    if (looksLikeImage) {
      const mimeType = IMAGE_TYPES.includes(contentType) ? contentType
        : lowerName.endsWith('.png') ? 'image/png'
        : lowerName.endsWith('.webp') ? 'image/webp'
        : 'image/jpeg';
      const transcribed = await callGemini({
        prompt: 'Transcribe every word of readable text in this image exactly as it appears, in reading order. Output ONLY the transcribed text — no commentary, no description of the image, no markdown. If there is no readable text, output nothing.',
        model: GEMINI_MODEL_FAST,
        imageBuffer: buffer,
        imageMimeType: mimeType,
      });
      return transcribed || '';
    }
    // txt / csv / anything else readable as plain text
    return buffer.toString('utf8');
  } catch (err) {
    logger.error('Text extraction failed', { fileName, err: err.message });
    return '';
  }
}

/**
 * Shared compliance-analysis call: given extracted document text, asks
 * Gemini to classify domain, score, and gaps. Used both by the automatic
 * on-upload pipeline and by manual/bulk re-analysis.
 */
async function runComplianceAnalysis(text) {
  const prompt = `You are a regulatory compliance analyst. Analyze the following document text and:
1. Identify which regulatory domain it most likely relates to (Data Privacy, Finance, HR, Cybersecurity, or Corporate Governance).
2. Give an overall compliance score from 0-100 based on how well the content reflects sound compliance practice.
3. List up to 5 specific gaps or risks found, each with a severity of High, Medium, or Low.
Respond ONLY as JSON in this exact shape:
{"domain":"...","score":0,"gaps":[{"title":"...","severity":"High","description":"..."}]}

DOCUMENT TEXT:
"""
${text.slice(0, 15000)}
"""`;

  const raw = await callGemini({ prompt, model: GEMINI_MODEL, jsonOutput: true });
  return safeJsonParse(raw, { domain: 'Unclassified', score: null, gaps: [] });
}

/**
 * Writes an analysis result to a document and fans out its High-severity
 * gaps as complianceIssues. If this document already has open issues from
 * a previous analysis (re-analysis case), those are closed out first so
 * re-running analysis doesn't pile up duplicate issues over time.
 */
async function applyAnalysisResult({ docRef, docId, orgId, fileName, analysis, actorUid, domainOverride, sourceText }) {
  // Embedding is best-effort: embedText() returns null on failure rather
  // than throwing, so a transient embedding-API hiccup never blocks the
  // analysis itself from being saved.
  const embedding = sourceText ? await embedText(sourceText) : null;

  await docRef.set(
    {
      status: 'analyzed',
      domain: domainOverride || analysis.domain || 'Unclassified', // user's explicit choice wins over the AI's guess
      score: typeof analysis.score === 'number' ? analysis.score : null,
      gaps: analysis.gaps || [],
      analyzedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(embedding ? { embedding } : {}),
    },
    { merge: true }
  );

  // Superseded issues from a prior run of this same document get marked
  // Resolved (not deleted — deleting would erase the audit trail of what
  // was previously flagged) before the fresh set is opened below.
  const staleSnap = await db.collection('complianceIssues')
    .where('documentId', '==', docId)
    .where('status', '==', 'Open')
    .get();
  const batch = db.batch();
  staleSnap.docs.forEach((d) => batch.update(d.ref, { status: 'Resolved', resolvedAt: admin.firestore.FieldValue.serverTimestamp(), resolvedReason: 'superseded-by-reanalysis' }));

  (analysis.gaps || [])
    .filter((g) => g.severity === 'High')
    .forEach((g) => {
      const issueRef = db.collection('complianceIssues').doc();
      batch.set(issueRef, {
        organizationId: orgId,
        documentId: docId,
        title: g.title,
        description: g.description || '',
        severity: g.severity,
        status: 'Open',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  await batch.commit();

  await writeAuditLog({ organizationId: orgId, actorUid, action: 'Document analyzed', target: fileName });
}

/* ============================================================
   AUTH TRIGGERS
   ============================================================ */

/** Creates the /users/{uid} profile document the moment someone signs up. */
exports.onUserCreate = functionsV1.auth.user().onCreate(async (user) => {
  await db.collection('users').doc(user.uid).set({
    uid: user.uid,
    email: user.email || null,
    displayName: user.displayName || (user.email ? user.email.split('@')[0] : 'New User'),
    photoURL: user.photoURL || null,
    role: null, // assigned once they create/join an organization
    organizationId: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
});

/** Clean up the profile doc when a user is deleted. */
exports.onUserDelete = functionsV1.auth.user().onDelete(async (user) => {
  await db.collection('users').doc(user.uid).delete();
});

/* ============================================================
   ORGANIZATION MANAGEMENT
   ============================================================ */

exports.createOrganization = onCall(async (request) => {
  const { uid } = requireAuth(request);
  const { name, plan = 'starter' } = request.data || {};
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    throw new HttpsError('invalid-argument', 'Organization name is required.');
  }

  const orgRef = db.collection('organizations').doc();
  await orgRef.set({
    name: name.trim(),
    plan,
    seats: plan === 'enterprise' ? 999 : plan === 'professional' ? 25 : 5,
    createdBy: uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection('users').doc(uid).update({
    organizationId: orgRef.id,
    role: 'admin',
  });

  // Custom claims let Storage Rules and the client check org/role
  // without an extra Firestore read on every request.
  await auth.setCustomUserClaims(uid, { orgId: orgRef.id, role: 'admin' });

  await writeAuditLog({
    organizationId: orgRef.id,
    actorUid: uid,
    action: 'Organization created',
    target: name.trim(),
  });

  return { organizationId: orgRef.id };
});

exports.inviteTeamMember = onCall(async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  if (caller.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only admins can invite team members.');
  }

  const { email, role = 'user' } = request.data || {};
  if (!isPlausibleEmail(email)) {
    throw new HttpsError('invalid-argument', 'A valid email address is required.');
  }
  const ALLOWED_ROLES = ['admin', 'compliance_officer', 'analyst', 'user'];
  if (!ALLOWED_ROLES.includes(role)) {
    throw new HttpsError('invalid-argument', `Role must be one of: ${ALLOWED_ROLES.join(', ')}.`);
  }

  const inviteRef = db.collection('organizations').doc(caller.organizationId).collection('invites').doc();
  await inviteRef.set({
    email,
    role,
    invitedBy: uid,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // NOTE: actually emailing the invite requires an email provider
  // (e.g. the official "Trigger Email" Firebase Extension, or SendGrid).
  // Wire that here once you've installed an extension — this function
  // already creates the invite record it would read from.

  await writeAuditLog({
    organizationId: caller.organizationId,
    actorUid: uid,
    action: 'Team member invited',
    target: email,
  });

  return { inviteId: inviteRef.id };
});

/**
 * Removes a member's access to the organization. Deliberately does NOT
 * delete their Firebase Auth account (irreversible, and they may belong
 * to other orgs in a multi-org future) — it clears their org membership
 * and role, and revokes the custom claims Storage Rules rely on, which is
 * enough to fully cut off access to this org's data.
 */
exports.removeTeamMember = onCall(async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  if (caller.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only admins can remove team members.');
  }
  const { targetUid } = request.data || {};
  if (!targetUid) throw new HttpsError('invalid-argument', 'targetUid is required.');
  if (targetUid === uid) throw new HttpsError('invalid-argument', "You can't remove yourself. Ask another admin.");

  const targetSnap = await db.collection('users').doc(targetUid).get();
  if (!targetSnap.exists || targetSnap.data().organizationId !== caller.organizationId) {
    throw new HttpsError('not-found', 'That user is not a member of your organization.');
  }

  await db.collection('users').doc(targetUid).update({ organizationId: null, role: null });
  await auth.setCustomUserClaims(targetUid, { orgId: null, role: null });

  await writeAuditLog({
    organizationId: caller.organizationId, actorUid: uid,
    action: 'Team member removed', target: targetSnap.data().email || targetUid,
  });

  return { removed: true };
});

/** Cancels a pending invite before it's accepted. */
exports.cancelInvite = onCall(async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  if (caller.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only admins can cancel invites.');
  }
  const { inviteId } = request.data || {};
  if (!inviteId) throw new HttpsError('invalid-argument', 'inviteId is required.');
  await db.collection('organizations').doc(caller.organizationId).collection('invites').doc(inviteId).delete();
  return { cancelled: true };
});

/* ============================================================
   DOCUMENT PROCESSING PIPELINE
   ============================================================ */

/**
 * Fires automatically when a file lands in Storage at
 * organizations/{orgId}/documents/{docId}/{fileName}
 * (the client uploads directly to that path, then this function
 * extracts text, runs the AI compliance analysis, and writes the
 * result to Firestore).
 */
exports.onDocumentUploaded = onObjectFinalized(
  { secrets: [GEMINI_API_KEY], memory: '1GiB', timeoutSeconds: 300 },
  async (event) => {
    const filePath = event.data.name; // organizations/{orgId}/documents/{docId}/{fileName}
    const contentType = event.data.contentType || '';
    const sizeBytes = Number(event.data.size || 0);
    const customMetadata = event.data.metadata || {}; // set client-side via uploadBytes(..., { customMetadata })
    const match = filePath.match(/^organizations\/([^/]+)\/documents\/([^/]+)\/(.+)$/);
    if (!match) return; // not a document upload path, ignore

    const [, orgId, docId, fileName] = match;
    const docRef = db.collection('documents').doc(docId);

    try {
      await docRef.set(
        {
          status: 'processing', organizationId: orgId, name: fileName, storagePath: filePath, contentType,
          size: sizeBytes > 0 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : null,
          country: customMetadata.country || null,
          domain: customMetadata.domain || null, // may be overwritten below once Gemini classifies the actual content
          uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      const [buffer] = await admin.storage().bucket().file(filePath).download();
      const text = await extractText(buffer, contentType, fileName);

      if (!text || text.trim().length < 20) {
        await docRef.set({ status: 'error', errorMessage: 'Could not extract readable text from this file.' }, { merge: true });
        return;
      }

      const analysis = await runComplianceAnalysis(text);
      await applyAnalysisResult({ docRef, docId, orgId, fileName, analysis, actorUid: 'system', domainOverride: customMetadata.domain, sourceText: text });
    } catch (err) {
      logger.error('Document processing failed', { filePath, err: err.message });
      await docRef.set({ status: 'error', errorMessage: err.message }, { merge: true });
    }
  }
);

/** Lets the frontend analyze pasted/typed text directly (no file upload). */
exports.analyzeText = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'analyzeText', { maxRequests: 20, windowMs: 60 * 60 * 1000 });
  const { text, country, domain } = request.data || {};
  if (!text || text.trim().length < 20) {
    throw new HttpsError('invalid-argument', 'Provide at least a few sentences of text to analyze.');
  }

  const prompt = `You are a regulatory compliance analyst reviewing a policy excerpt for an organization operating in ${country || 'an unspecified jurisdiction'}, in the ${domain || 'general'} domain.
Identify compliance gaps and give an overall score 0-100.
Respond ONLY as JSON: {"score":0,"gaps":[{"title":"...","severity":"High|Medium|Low","description":"..."}],"summary":"..."}

TEXT:
"""
${text.slice(0, 15000)}
"""`;

  const raw = await callGemini({ prompt, jsonOutput: true });
  const result = safeJsonParse(raw, { score: null, gaps: [], summary: raw });

  await writeAuditLog({ organizationId: caller.organizationId, actorUid: uid, action: 'Ad-hoc text analysis', target: `${text.slice(0, 40)}...` });
  return result;
});

/* ============================================================
   AI ASSISTANT CHAT
   ============================================================ */

/* ============================================================
   PLATFORM ADMIN — deliberately separate from the per-org 'admin' role.
   Gated by membership in the `platformAdmins` collection, which has NO
   client write rule at all (see firestore.rules) — it can only be
   populated by someone with direct Firebase Admin SDK / console access
   to your project, i.e. you, manually, after deploying. That's
   intentional: a regular org admin must never be able to grant
   themselves platform-wide access to every other customer's data, and
   an app button can't be trusted to enforce that boundary — only a
   step outside the app can. See SETUP.md §9 for how to add yourself.
   ============================================================ */
async function requirePlatformAdmin(uid) {
  const snap = await db.collection('platformAdmins').doc(uid).get();
  if (!snap.exists) {
    throw new HttpsError('permission-denied', 'This requires platform admin access.');
  }
}

/** Real counts only — no fabricated MRR or AI-usage numbers. This project
 * has no billing integration (Stripe etc.) and no per-request usage
 * logging, so those genuinely can't be reported; returning null for them
 * here (and the frontend showing "Not tracked") is honest, a made-up
 * number would not be. */
exports.getPlatformStats = onCall(async (request) => {
  const { uid } = requireAuth(request);
  await requirePlatformAdmin(uid);

  const [orgsSnap, usersSnap] = await Promise.all([
    db.collection('organizations').count().get(),
    db.collection('users').count().get(),
  ]);

  return {
    organizationCount: orgsSnap.data().count,
    userCount: usersSnap.data().count,
    mrr: null, // no billing integration wired in — see SETUP.md
    aiRequestsLast24h: null, // no usage logging wired in — see SETUP.md
  };
});

/** Real organization list (name, plan, seats, createdAt) — no fabricated
 * per-org MRR since there's no billing integration to source it from. */
exports.listAllOrganizations = onCall(async (request) => {
  const { uid } = requireAuth(request);
  await requirePlatformAdmin(uid);

  const orgsSnap = await db.collection('organizations').orderBy('createdAt', 'desc').limit(200).get();
  return {
    organizations: orgsSnap.docs.map((d) => {
      const v = d.data();
      return { id: d.id, name: v.name || 'Unnamed', plan: v.plan || 'starter', seats: v.seats || 0, createdAt: v.createdAt ? v.createdAt.toDate().toISOString() : null };
    }),
  };
});

exports.chatWithAssistant = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'chatWithAssistant', { maxRequests: 60, windowMs: 60 * 60 * 1000 });
  const { message, conversationId, history = [] } = request.data || {};
  if (!message || !message.trim()) {
    throw new HttpsError('invalid-argument', 'Message is required.');
  }

  // Real retrieval: embed the question, compare against every analyzed
  // document's stored embedding with cosine similarity, and use the
  // closest matches as context — not just whichever documents were
  // uploaded most recently. Brute-force over up to 200 docs (bounded so
  // an org with a very large document set can't blow up latency/cost on
  // every chat message); genuinely large orgs would want an indexed ANN
  // vector store instead of comparing every document on every message —
  // see the note on embedText() for why that's not deployed here.
  const [docsSnap, regsSnap] = await Promise.all([
    db.collection('documents').where('organizationId', '==', caller.organizationId).where('status', '==', 'analyzed').orderBy('uploadedAt', 'desc').limit(200).get(),
    db.collection('regulations').limit(10).get(),
  ]);

  let relevantDocs = docsSnap.docs.map((d) => d.data());
  const queryEmbedding = await embedText(message);
  if (queryEmbedding) {
    relevantDocs = relevantDocs
      .map((v) => ({ v, sim: v.embedding ? cosineSimilarity(queryEmbedding, v.embedding) : -1 }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 5)
      .map((x) => x.v);
  } else {
    // Embedding API unavailable this call — fall back to recency rather
    // than failing the whole chat message.
    relevantDocs = relevantDocs.slice(0, 5);
  }

  const docContext = relevantDocs.map((v) => {
    return `- ${v.name}: domain=${v.domain || 'n/a'}, score=${v.score ?? 'n/a'}, gaps=${(v.gaps || []).map((g) => g.title).join('; ')}`;
  }).join('\n');

  const regContext = regsSnap.docs.map((d) => {
    const v = d.data();
    return `- ${v.shortName || v.name} (${v.country || 'global'}): ${v.description || ''}`;
  }).join('\n');

  const historyText = history.slice(-8).map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.text}`).join('\n');

  const systemInstruction = `You are the ORDINEX compliance assistant for the organization "${caller.organizationName || ''}". Answer using the organization's document context and the regulation reference context below when relevant. Be concise, cite which document or regulation you're drawing from, and never invent legal citations you are not given.

ORGANIZATION DOCUMENTS (most relevant to this question):
${docContext || '(no analyzed documents yet)'}

REGULATION REFERENCE:
${regContext || '(no regulations loaded yet)'}`;

  const prompt = `${historyText ? historyText + '\n' : ''}User: ${message}`;

  const reply = await callGemini({ prompt, systemInstruction, model: GEMINI_MODEL_FAST });

  const convRef = conversationId
    ? db.collection('chatConversations').doc(conversationId)
    : db.collection('chatConversations').doc();

  await convRef.set({ userId: uid, organizationId: caller.organizationId, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const messagesRef = convRef.collection('messages');
  await messagesRef.add({ role: 'user', text: message, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  await messagesRef.add({ role: 'assistant', text: reply, createdAt: admin.firestore.FieldValue.serverTimestamp() });

  return { conversationId: convRef.id, reply };
});

/* ============================================================
   RISK ASSESSMENT
   ============================================================ */

exports.assessRisk = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'assessRisk', { maxRequests: 10, windowMs: 60 * 60 * 1000 });

  const docsSnap = await db.collection('documents').where('organizationId', '==', caller.organizationId).where('status', '==', 'analyzed').get();
  const docsSummary = docsSnap.docs.map((d) => {
    const v = d.data();
    return `- ${v.name} (domain: ${v.domain}, score: ${v.score}): ${(v.gaps || []).map((g) => `${g.severity}: ${g.title}`).join('; ')}`;
  }).join('\n') || '(no analyzed documents yet — general baseline assessment)';

  const prompt = `Based on the following analyzed compliance documents for an organization, produce an overall risk assessment.
Respond ONLY as JSON:
{"overallScore":0,"confidence":0,"categories":[{"name":"Regulatory Compliance","score":0,"level":"High Risk|Medium Risk|Low Risk","findings":["..."]},{"name":"Operational Risk","score":0,"level":"...","findings":["..."]},{"name":"Data Security","score":0,"level":"...","findings":["..."]},{"name":"Vendor Risk","score":0,"level":"...","findings":["..."]}],"recommendations":["...","...","...","..."]}

DOCUMENTS:
${docsSummary}`;

  const raw = await callGemini({ prompt, jsonOutput: true });
  const result = safeJsonParse(raw, { overallScore: null, categories: [], recommendations: [] });

  const riskRef = db.collection('riskAssessments').doc();
  await riskRef.set({
    organizationId: caller.organizationId,
    ...result,
    createdBy: uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await writeAuditLog({ organizationId: caller.organizationId, actorUid: uid, action: 'Risk assessment generated', target: riskRef.id });

  return { riskAssessmentId: riskRef.id, ...result };
});

/* ============================================================
   REPORT GENERATION
   ============================================================ */

exports.generateReport = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'generateReport', { maxRequests: 15, windowMs: 60 * 60 * 1000 });
  const { title, type = 'Compliance Report' } = request.data || {};
  if (!title) throw new HttpsError('invalid-argument', 'Report title is required.');

  const reportRef = db.collection('complianceReports').doc();
  await reportRef.set({
    organizationId: caller.organizationId,
    title,
    type,
    status: 'generating',
    createdBy: uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const [docsSnap, riskSnap] = await Promise.all([
    db.collection('documents').where('organizationId', '==', caller.organizationId).where('status', '==', 'analyzed').get(),
    db.collection('riskAssessments').where('organizationId', '==', caller.organizationId).orderBy('createdAt', 'desc').limit(1).get(),
  ]);

  const docsSummary = docsSnap.docs.map((d) => d.data()).map((v) => `- ${v.name}: score ${v.score}, gaps: ${(v.gaps || []).length}`).join('\n');
  const riskSummary = riskSnap.empty ? '(no risk assessment on file)' : JSON.stringify(riskSnap.docs[0].data());

  const prompt = `Write an executive summary (250-400 words) for a "${type}" titled "${title}" for an organization, based on:

DOCUMENT ANALYSES:
${docsSummary || '(none yet)'}

LATEST RISK ASSESSMENT:
${riskSummary}

Write in a professional, board-ready tone. Do not use markdown headers.`;

  const summary = await callGemini({ prompt });

  await reportRef.update({
    status: 'completed',
    summary,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await writeAuditLog({ organizationId: caller.organizationId, actorUid: uid, action: 'Report generated', target: title });

  return { reportId: reportRef.id, summary };
});

/**
 * Real DOCX export — previously only PDF existed (client-side via jsPDF).
 * Builds an actual OOXML .docx with the `docx` package and returns it as
 * base64 for the client to decode into a Blob and download, the same way
 * the PDF path already works client-side.
 */
exports.exportReportDocx = onCall(async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  const { reportId } = request.data || {};
  if (!reportId) throw new HttpsError('invalid-argument', 'reportId is required.');

  const reportSnap = await db.collection('complianceReports').doc(reportId).get();
  if (!reportSnap.exists) throw new HttpsError('not-found', 'Report not found.');
  const report = reportSnap.data();
  if (report.organizationId !== caller.organizationId) {
    throw new HttpsError('permission-denied', 'This report does not belong to your organization.');
  }

  const bodyParagraphs = (report.summary || '').split('\n').filter((p) => p.trim().length > 0)
    .map((p) => new Paragraph({ children: [new TextRun(p)], spacing: { after: 200 } }));

  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ text: 'ORDINEX', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: report.title || 'Untitled Report', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: `${report.type || 'Report'} • Generated ${report.createdAt && report.createdAt.toDate ? report.createdAt.toDate().toISOString().slice(0, 10) : ''}`, spacing: { after: 300 } }),
        new Paragraph({ text: 'Executive Summary', heading: HeadingLevel.HEADING_3 }),
        ...(bodyParagraphs.length ? bodyParagraphs : [new Paragraph({ text: '(No content yet.)' })]),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return { base64: buffer.toString('base64'), filename: `${(report.title || 'report').replace(/[^a-z0-9]/gi, '_')}.docx` };
});

/**
 * Report editor: AI-regenerates the executive summary from the org's
 * current documents/risk data (same inputs as generateReport), and keeps
 * the previous version in versionHistory rather than silently overwriting
 * it — this is the "version history" + "regenerate with AI" half of the
 * report editor; saving manual text edits is a plain client-side updateDoc
 * (already permitted by firestore.rules for admin/compliance_officer),
 * no Cloud Function needed for that part.
 */
exports.reviseReportSummary = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'reviseReportSummary', { maxRequests: 20, windowMs: 60 * 60 * 1000 });
  const { reportId, instructions } = request.data || {};
  if (!reportId) throw new HttpsError('invalid-argument', 'reportId is required.');

  const reportRef = db.collection('complianceReports').doc(reportId);
  const reportSnap = await reportRef.get();
  if (!reportSnap.exists) throw new HttpsError('not-found', 'Report not found.');
  const report = reportSnap.data();
  if (report.organizationId !== caller.organizationId) {
    throw new HttpsError('permission-denied', 'This report does not belong to your organization.');
  }

  const [docsSnap, riskSnap] = await Promise.all([
    db.collection('documents').where('organizationId', '==', caller.organizationId).where('status', '==', 'analyzed').get(),
    db.collection('riskAssessments').where('organizationId', '==', caller.organizationId).orderBy('createdAt', 'desc').limit(1).get(),
  ]);
  const docsSummary = docsSnap.docs.map((d) => d.data()).map((v) => `- ${v.name}: score ${v.score}, gaps: ${(v.gaps || []).length}`).join('\n');
  const riskSummary = riskSnap.empty ? '(no risk assessment on file)' : JSON.stringify(riskSnap.docs[0].data());

  const prompt = `Rewrite the executive summary (250-400 words) for a "${report.type}" titled "${report.title}", based on:

DOCUMENT ANALYSES:
${docsSummary || '(none yet)'}

LATEST RISK ASSESSMENT:
${riskSummary}

PREVIOUS VERSION OF THIS SUMMARY (for context, don't just repeat it — reflect the latest data above):
${report.summary || '(none yet)'}
${instructions ? `\nADDITIONAL INSTRUCTIONS FROM THE EDITOR: ${instructions}` : ''}

Write in a professional, board-ready tone. Do not use markdown headers.`;

  const newSummary = await callGemini({ prompt });

  await reportRef.update({
    summary: newSummary,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    versionHistory: admin.firestore.FieldValue.arrayUnion({
      summary: report.summary || '',
      savedAt: new Date().toISOString(), // client-readable timestamp; arrayUnion can't hold serverTimestamp() sentinels
      editedBy: uid,
    }),
  });

  await writeAuditLog({ organizationId: caller.organizationId, actorUid: uid, action: 'Report section regenerated by AI', target: report.title });

  return { summary: newSummary };
});

/**
 * Re-downloads the original file from Storage, re-extracts its text, and
 * asks Gemini to rewrite the FULL document addressing every gap that was
 * found during the original analysis. Returns the revised text for the
 * client to package into a downloadable file (the frontend renders it to
 * PDF via jsPDF — see downloadTextAsPdf() in ordinex.html).
 */
exports.reviseDocument = onCall({ secrets: [GEMINI_API_KEY], memory: '1GiB', timeoutSeconds: 300 }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'reviseDocument', { maxRequests: 10, windowMs: 60 * 60 * 1000 });
  const { documentId } = request.data || {};
  if (!documentId) throw new HttpsError('invalid-argument', 'documentId is required.');

  const docSnap = await db.collection('documents').doc(documentId).get();
  if (!docSnap.exists) throw new HttpsError('not-found', 'Document not found.');
  const docData = docSnap.data();

  if (docData.organizationId !== caller.organizationId) {
    throw new HttpsError('permission-denied', 'This document does not belong to your organization.');
  }
  if (!docData.storagePath) {
    throw new HttpsError('failed-precondition', 'This document has no stored file to revise.');
  }
  if (!docData.gaps || docData.gaps.length === 0) {
    throw new HttpsError('failed-precondition', 'No compliance gaps were found for this document — nothing to revise.');
  }

  const [buffer] = await admin.storage().bucket().file(docData.storagePath).download();
  const text = await extractText(buffer, docData.contentType || '', docData.name || '');
  if (!text || text.trim().length < 20) {
    throw new HttpsError('failed-precondition', 'Could not re-extract readable text from the original file.');
  }

  const gapsText = docData.gaps
    .map((g, i) => `${i + 1}. [${g.severity}] ${g.title}: ${g.description || ''}`)
    .join('\n');

  const prompt = `You are a compliance editor. Below is the original text of a policy document, followed by a list of compliance gaps found in it.
Rewrite the FULL document, preserving its structure and tone, but revising it to address every gap listed.
Output ONLY the revised document text itself — no commentary, no headers like "Revised Document", no explanations, ready to replace the original.

COMPLIANCE GAPS TO FIX:
${gapsText}

ORIGINAL DOCUMENT TEXT:
"""
${text.slice(0, 15000)}
"""`;

  const revisedText = await callGemini({ prompt, model: GEMINI_MODEL });
  if (!revisedText || revisedText.trim().length < 20) {
    throw new HttpsError('internal', 'The AI did not return a usable revision. Try again.');
  }

  await writeAuditLog({
    organizationId: caller.organizationId,
    actorUid: uid,
    action: 'Document revised by AI',
    target: docData.name || documentId,
  });

  return { revisedText, documentName: docData.name || 'document', gapsAddressed: docData.gaps.length };
});

/* ============================================================
   BULK RE-ANALYSIS — real backend for the "New Analysis" button on the
   Compliance Gap Analysis page, which previously only showed a toast.
   ============================================================ */
exports.reanalyzeAllDocuments = onCall({ secrets: [GEMINI_API_KEY], memory: '1GiB', timeoutSeconds: 540 }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'reanalyzeAllDocuments', { maxRequests: 5, windowMs: 60 * 60 * 1000 });

  const docsSnap = await db.collection('documents')
    .where('organizationId', '==', caller.organizationId)
    .where('status', 'in', ['analyzed', 'error'])
    .limit(25) // cap per run to stay inside the function timeout; re-run to cover more
    .get();

  if (docsSnap.empty) {
    return { reanalyzed: 0, failed: 0, message: 'No previously-analyzed documents to re-run.' };
  }

  let reanalyzed = 0;
  const failures = [];

  // Sequential, not Promise.all: Gemini calls are rate-limited per project,
  // and this keeps memory bounded regardless of how many documents exist.
  for (const doc of docsSnap.docs) {
    const docData = doc.data();
    try {
      if (!docData.storagePath) throw new Error('No stored file for this document.');
      const [buffer] = await admin.storage().bucket().file(docData.storagePath).download();
      const text = await extractText(buffer, docData.contentType || '', docData.name || '');
      if (!text || text.trim().length < 20) throw new Error('Could not extract readable text.');

      const analysis = await runComplianceAnalysis(text);
      await applyAnalysisResult({
        docRef: doc.ref, docId: doc.id, orgId: caller.organizationId,
        fileName: docData.name || doc.id, analysis, actorUid: uid, domainOverride: docData.domain, sourceText: text,
      });
      reanalyzed += 1;
    } catch (err) {
      logger.error('Re-analysis failed for document', { docId: doc.id, err: err.message });
      failures.push({ documentId: doc.id, name: docData.name, error: err.message });
    }
  }

  await writeAuditLog({
    organizationId: caller.organizationId, actorUid: uid,
    action: 'Bulk re-analysis run', target: `${reanalyzed} document(s)`,
  });

  return { reanalyzed, failed: failures.length, failures };
});

/* ============================================================
   REGULATION DATABASE SYNC — real backend for the Regulation Comparison
   and Knowledge Base pages, which previously only ever read a hardcoded
   JS array baked into the frontend. This seeds a curated starter set into
   Firestore; the frontend now reads live from the `regulations` collection.
   Swap the REGULATION_SEED_SET below for a real scheduled fetch from
   official sources (eur-lex.europa.eu, oag.ca.gov, etc.) when you're ready
   to automate updates — this is intentionally a manual-trigger starting
   point, not a scraper, since automated legal-text ingestion needs a
   licensing/compliance review this project can't make for you.
   ============================================================ */
const REGULATION_SEED_SET = [
  { id: 'reg_gdpr', name: 'General Data Protection Regulation', short: 'GDPR', country: 'Germany', countryCode: 'DE', domain: 'Data Privacy', status: 'active',
    description: 'EU regulation on data protection and privacy, protecting personal data of EU citizens.',
    tags: ['Data Protection', 'Privacy', 'EU', 'Personal Data'],
    requirements: [
      { title: 'Article 5 — Principles relating to processing of personal data', desc: 'Personal data shall be processed lawfully, fairly and in a transparent manner.', status: 'met' },
      { title: 'Article 6 — Lawfulness of processing', desc: 'Processing shall be lawful only if consent is given or a legal obligation exists.', status: 'met' },
      { title: 'Article 7 — Conditions for consent', desc: 'Consent must be freely given, specific, informed and unambiguous.', status: 'gap' },
      { title: 'Article 33 — Breach notification', desc: 'Notify the supervisory authority within 72 hours of becoming aware of a breach.', status: 'partial' },
    ] },
  { id: 'reg_ccpa', name: 'California Consumer Privacy Act', short: 'CCPA', country: 'United States', countryCode: 'US', domain: 'Data Privacy', status: 'active',
    description: 'California state law enhancing privacy rights and consumer protection for residents.',
    tags: ['Privacy', 'Consumer Rights', 'California', 'Data Sales'],
    requirements: [
      { title: 'Right to Know', desc: 'Consumers have the right to know what personal information is being collected.', status: 'met' },
      { title: 'Right to Delete', desc: 'Consumers may request deletion of personal information collected.', status: 'met' },
      { title: 'Right to Opt-Out', desc: 'Consumers may opt out of the sale of personal information.', status: 'partial' },
    ] },
  { id: 'reg_sox', name: 'Sarbanes-Oxley Act', short: 'SOX', country: 'United States', countryCode: 'US', domain: 'Finance', status: 'active',
    description: 'US federal law mandating strict reforms to improve financial disclosures and prevent accounting fraud.',
    tags: ['Financial Reporting', 'Internal Controls', 'Auditing', 'Corporate Governance'],
    requirements: [
      { title: 'Section 302 — Corporate Responsibility', desc: 'Officers must certify accuracy of financial statements.', status: 'met' },
      { title: 'Section 404 — Internal Controls', desc: 'Management must document and assess internal control structure.', status: 'gap' },
    ] },
  { id: 'reg_pcidss', name: 'Payment Card Industry Data Security Standard', short: 'PCI DSS', country: 'United Kingdom', countryCode: 'UK', domain: 'Cybersecurity', status: 'active',
    description: 'Information security standard for organizations that handle credit card data.',
    tags: ['Card Data', 'Security', 'Payments', 'Encryption'],
    requirements: [
      { title: 'Requirement 3 — Protect stored cardholder data', desc: 'Render PAN unreadable anywhere it is stored.', status: 'met' },
      { title: 'Requirement 10 — Track and monitor access', desc: 'Log and monitor all access to network resources and cardholder data.', status: 'partial' },
    ] },
  { id: 'reg_pipl', name: 'Personal Information Protection Law', short: 'PIPL', country: 'Japan', countryCode: 'JP', domain: 'Data Privacy', status: 'active',
    description: 'Law governing the handling of personal information by businesses.',
    tags: ['Privacy', 'Japan', 'Personal Information', 'Consent'],
    requirements: [
      { title: 'Purpose limitation', desc: 'Personal information may only be used for the stated purpose of collection.', status: 'met' },
    ] },
  { id: 'reg_mas', name: 'Monetary Authority of Singapore Guidelines', short: 'MAS Guidelines', country: 'Singapore', countryCode: 'SG', domain: 'Finance', status: 'active',
    description: 'Central bank guidelines on technology risk management and cybersecurity for financial institutions.',
    tags: ['Financial Services', 'Technology Risk', 'Singapore', 'Cybersecurity'],
    requirements: [
      { title: 'TRM Guideline 6.2', desc: 'Establish incident management and response processes.', status: 'partial' },
    ] },
];

exports.seedRegulations = onCall(async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  if (caller.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only an organization admin can sync the regulation database.');
  }

  const batch = db.batch();
  REGULATION_SEED_SET.forEach((reg) => {
    const { id, ...data } = reg;
    batch.set(db.collection('regulations').doc(id), {
      ...data,
      lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'manual-seed', // flip to a real source name once a live feed is wired in
    }, { merge: true });
  });
  await batch.commit();

  await writeAuditLog({
    organizationId: caller.organizationId, actorUid: uid,
    action: 'Regulation database synced', target: `${REGULATION_SEED_SET.length} regulation(s)`,
  });

  return { synced: REGULATION_SEED_SET.length };
});

/* ============================================================
   NOTIFICATIONS — fan out on new high-severity issues
   ============================================================ */

exports.onComplianceIssueCreated = onDocumentCreated('complianceIssues/{issueId}', async (event) => {
  const issue = event.data.data();
  if (issue.severity !== 'High') return;

  const usersSnap = await db.collection('users').where('organizationId', '==', issue.organizationId).get();
  const batch = db.batch();
  usersSnap.docs.forEach((u) => {
    const notifRef = db.collection('notifications').doc();
    batch.set(notifRef, {
      userId: u.id,
      organizationId: issue.organizationId,
      title: 'Critical Compliance Gap Detected',
      body: issue.title,
      level: 'Critical',
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
});

/* ============================================================
   Exported for unit testing only (functions/test/analysis.test.js).
   Pure helpers with no Firebase/Gemini calls, so they're actually
   testable without an emulator or live credentials.
   ============================================================ */
exports._testables = { safeJsonParse, isPlausibleEmail, cosineSimilarity, checkRateWindow };
