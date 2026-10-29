# Free AI on the live website (no paid plan, no server)

Ordinex has no AI server and uses no Blaze/Cloud Functions. AI works in one of two free ways:

1. **Your own free Gemini key (works for anyone, nothing to install).** Click the AI badge (bottom right) on the live
   site, create a free key at aistudio.google.com/apikey, paste it. The key is kept only in that browser's
   localStorage; it is never written to Firestore, never sent to Ordinex, and calls go from the browser to Google under
   the user's own free quota (sent in a header, never in a URL).
2. **A local backend (text stays on your computer).** `npm run ai` with Ollama, then "Connect local backend".
   When connected it always takes precedence over a key.

## Be honest about the trade-offs
- With a key, document text is sent to Google Gemini, and free-tier content may be used by Google to improve its
  products. The setup dialog, the Security & Audit page and System Status all say so.
- A key in localStorage is readable by any script running on the site. The app escapes user data and its rules block
  injected IDs, but treat the key as low-value: use a dedicated free key and remove it on shared computers.
- Free quotas are small and per user; the app reports "quota used up" clearly.
- Key-based analysis uses the prompt-based pipeline: results are model-estimated and need human review. The local
  backend adds retrieval, citations and the deterministic risk score. Image OCR (JPG/PNG) works with a key (the image is
  sent to Google); it is not available with the local backend.
