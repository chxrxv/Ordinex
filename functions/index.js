'use strict';
/* Hosted AI proxy for the live website: ONE callable function, `aiGenerate`.
   - requires a signed-in Firebase user who belongs to an organisation
   - per-user daily quota (Firestore aiUsage/{uid_YYYYMMDD}; clients cannot touch that collection: rules default-deny)
   - Gemini API key lives only in the GEMINI_API_KEY secret; it never reaches the browser
   - maxInstances caps concurrency, and so worst-case spend
   Deploying this needs the Blaze plan. See docs/HOSTED_AI.md. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const ai = require('./ai');

admin.initializeApp();
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

exports.aiGenerate = onCall(
  { region: 'us-central1', secrets: [GEMINI_API_KEY], maxInstances: 3, timeoutSeconds: 120, memory: '256MiB', cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to use AI analysis.');
    const uid = request.auth.uid;
    try {
      const input = ai.validateInput(request.data);
      const db = admin.firestore();
      const profile = await db.doc(`users/${uid}`).get();
      if (!profile.exists || !profile.data().organizationId) throw new ai.AiError('permission-denied', 'Join or create an organisation to use AI analysis.');
      const ref = db.doc(`aiUsage/${ai.dayKey(uid)}`);
      await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        tx.set(ref, { uid, count: ai.nextUsage(s.exists ? s.data().count : 0), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      return { text: await ai.callGemini(GEMINI_API_KEY.value(), input) };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      if (e instanceof ai.AiError) throw new HttpsError(e.code, e.message);
      console.error('aiGenerate failed:', e && e.message ? String(e.message).slice(0, 200) : 'unknown');
      throw new HttpsError('internal', 'AI analysis failed unexpectedly.');
    }
  },
);
