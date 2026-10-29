# Languages

15 languages are offered for AI-written text: English, Hindi, Kannada, Tamil, Telugu, Bengali, Marathi, German, French,
Spanish, Japanese, Chinese, Korean, Arabic, Portuguese.

## What works
- **Findings language** (Upload dialog, "Write findings in"): the AI writes finding titles, descriptions and recommendations
  in the chosen language. JSON keys and severity values (High/Medium/Low) stay English so the app keeps working.
  Applies when AI runs through a user's Gemini key or the hosted proxy.
- **Report language** (Generate Report dialog): the report summary is written in the chosen language; the choice is stored on
  the report (`language`) and reused when the summary is regenerated. Document and regulatory-source languages are passed as context.
- Safety: only codes from the fixed list are accepted; anything else falls back to English, so a tampered form value can
  never put text into a prompt.

## Checked with real Gemini (local emulator app, 2026-10-29)
Kannada, Hindi, Spanish and Japanese findings were each written in the target language with English severities, and a
Kannada report came back fully in Kannada. Other listed languages use the same code path but were NOT individually tested.

## Limits (be honest with users)
- The local backend (qwen3:4b) still writes findings in English; the app says so when another language is chosen.
- AI text in non-English languages can contain errors, especially legal terms. A native speaker must review it before it
  is relied on. The dialog says so.
- The app interface itself (menus, buttons) is English only; there is no UI translation yet.
- Regulation reference records are English paraphrases; they are not translated.
