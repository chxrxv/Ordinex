'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { detectLanguageFromText, getLanguageCapability } = require('../../functions-optional-blaze-upgrade/evidence-model');

const STD_FONTS = require('node:path').join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
const ALLOWED = { '.pdf': 'PDF', '.docx': 'DOCX', '.txt': 'TXT', '.md': 'TXT' };
const CHUNK_TARGET = 450;

/** Strips directories and anything unsafe; the result is only ever used as a
 * display label — files are never written to disk under a user-supplied path. */
function safeName(name) {
  const base = path.basename(String(name || 'document').replace(/\\/g, '/')).replace(/[^\w.\- ()]/g, '_');
  // Truncate the stem, never the extension (a cut-off extension would turn a valid .txt into "unsupported").
  const ext = path.extname(base).slice(0, 12);
  const stem = base.slice(0, base.length - ext.length).slice(0, 120 - ext.length);
  return (stem + ext) || 'document';
}

/** Splits [{ref, text}] units into ~900-char chunks; every chunk keeps its
 * page / paragraph reference. */
function chunkUnits(units, docId) {
  const chunks = [];
  let buf = [], len = 0, firstRef = null, lastRef = null;
  const flush = () => {
    if (!buf.length) return;
    chunks.push({ id: `${docId}-c${chunks.length + 1}`, docId, ref: firstRef === lastRef ? firstRef : `${firstRef}–${lastRef}`, text: buf.join('\n') });
    buf = []; len = 0; firstRef = null;
  };
  for (const u of units) {
    const pieces = u.text.length > CHUNK_TARGET * 1.5
      ? u.text.match(new RegExp(`[\\s\\S]{1,${CHUNK_TARGET}}(?:\\s|$)`, 'g')) || [u.text]
      : [u.text];
    for (const piece of pieces) {
      const t = piece.trim();
      if (!t) continue;
      if (len + t.length > CHUNK_TARGET && buf.length) flush();
      if (!buf.length) firstRef = u.ref;
      buf.push(t); len += t.length; lastRef = u.ref;
    }
  }
  flush();
  return chunks;
}

async function extractPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, verbosity: 0, standardFontDataUrl: STD_FONTS });
  const pdf = await task.promise;
  try {
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      pages.push(tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim());
    }
    return { pages, numPages: pdf.numPages };
  } finally { await pdf.destroy(); }
}

/** Real extraction with honest status values:
 *  parsed | empty | needs-ocr | encrypted | malformed | unsupported | too-large */
async function ingest({ filename, buffer, maxBytes = 25 * 1024 * 1024 }) {
  const name = safeName(filename);
  const id = 'doc-' + crypto.randomBytes(5).toString('hex');
  const ext = path.extname(name).toLowerCase();
  const base = {
    id, name, type: ALLOWED[ext] || 'unsupported', sizeBytes: buffer?.length || 0,
    sha256: buffer ? crypto.createHash('sha256').update(buffer).digest('hex') : null,
    chunks: [], ocr: { attempted: false, note: 'OCR is not installed in this build.' },
  };
  const fail = (status, message, extra = {}) => ({ ...base, status, message, ...extra });

  if (!ALLOWED[ext]) return fail('unsupported', `Unsupported file type "${ext || 'none'}". Supported: PDF, DOCX, TXT.`);
  if (!buffer || buffer.length === 0) return fail('empty', 'The file is empty.');
  if (buffer.length > maxBytes) return fail('too-large', `File exceeds ${Math.round(maxBytes / 1048576)} MB limit.`);

  let units = [];
  try {
    if (ext === '.pdf') {
      if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return fail('malformed', 'File does not look like a PDF (missing %PDF header).');
      const { pages, numPages } = await extractPdf(buffer);
      const chars = pages.join('').length;
      if (chars === 0 || chars / Math.max(1, numPages) < 25) {
        return fail('needs-ocr', 'This PDF has no selectable text (likely scanned). OCR is not available in this build, so it was NOT analysed.', { pages: numPages });
      }
      units = pages.map((t, i) => ({ ref: `p.${i + 1}`, text: t })).filter((u) => u.text);
    } else if (ext === '.docx') {
      const mammoth = require('mammoth');
      const { value } = await mammoth.extractRawText({ buffer });
      units = value.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).map((t, i) => ({ ref: `¶${i + 1}`, text: t }));
    } else {
      const text = buffer.toString('utf8');
      if (text.includes('\u0000')) return fail('malformed', 'Binary content detected in a text file.');
      units = text.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).map((t, i) => ({ ref: `¶${i + 1}`, text: t }));
    }
  } catch (e) {
    if (/password|encrypt/i.test(e.name + e.message) || e.name === 'PasswordException') return fail('encrypted', 'The document is password-protected / encrypted. Remove protection and re-upload.');
    return fail('malformed', 'The document could not be parsed: ' + String(e.message).slice(0, 120));
  }
  if (!units.length) return fail('empty', 'No text found in the document.');

  const original = units.map((u) => u.text).join('\n');
  const language = detectLanguageFromText(original);
  const cap = getLanguageCapability(language);
  return {
    ...base, status: 'parsed', language, languageSupported: cap.supported,
    // Original text is kept verbatim; no translation is ever substituted for it.
    translation: { status: 'none', verified: false },
    reviewRequired: language !== 'en',
    reviewReason: language !== 'en'
      ? `Document language "${cap.name}" was detected heuristically. The local model's reliability on legal text in this language is unmeasured; findings need human review.`
      : null,
    chunks: chunkUnits(units, id),
    charCount: original.length,
  };
}

module.exports = { ingest, chunkUnits, safeName };
