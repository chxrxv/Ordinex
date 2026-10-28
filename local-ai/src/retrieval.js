'use strict';
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const STOP = new Set('the a an and or of to in for on with by is are be as at from that this it its we our any all must shall may'.split(' '));

/** Tokenise to FTS-safe lowercase alphanumerics. User/document text is never
 * interpolated into SQL or FTS syntax unescaped. */
function tokens(text) {
  return [...new Set(String(text || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])].filter((t) => !STOP.has(t));
}

function ftsQuery(terms) {
  const parts = terms.flatMap((t) => (/\s/.test(t) ? [`"${tokens(t).join(' ')}"`] : tokens(t))).filter((p) => p && p !== '""');
  return [...new Set(parts)].map((p) => (p.startsWith('"') ? p : `"${p}"`)).join(' OR ');
}

/** In-memory SQLite FTS5 index (BM25 ranking). */
class Index {
  constructor(columns) {
    this.db = new DatabaseSync(':memory:');
    this.cols = columns;
    this.db.exec(`CREATE VIRTUAL TABLE t USING fts5(id UNINDEXED, ${columns.join(', ')}, tokenize='unicode61 remove_diacritics 2')`);
    this.ins = this.db.prepare(`INSERT INTO t(id, ${columns.join(', ')}) VALUES (?${', ?'.repeat(columns.length)})`);
  }
  add(id, ...vals) { this.ins.run(id, ...vals); }
  search(terms, limit = 10) {
    const q = ftsQuery(terms);
    if (!q) return [];
    // bm25() is lower = better; expose as a positive relevance score.
    return this.db.prepare(`SELECT id, -bm25(t) AS score FROM t WHERE t MATCH ? ORDER BY bm25(t) LIMIT ?`).all(q, limit)
      .map((r) => ({ id: r.id, score: Number(r.score.toFixed(3)) }));
  }
}

// ------------------------------------------------------------ regulations
let cache = null;
function loadRegulations(file = config.regulationsFile) {
  if (cache && cache.file === file) return cache;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const provisions = new Map();
  const regs = new Map();
  const index = new Index(['title', 'obligation', 'terms']);
  for (const reg of raw.regulations) {
    regs.set(reg.id, reg);
    for (const p of reg.provisions) {
      const full = { ...p, regulationId: reg.id, regulationShort: reg.short, jurisdictions: reg.jurisdictions, sourceUrl: reg.sourceUrl };
      provisions.set(p.id, full);
      index.add(p.id, p.title, p.obligation, (p.evidenceTerms || []).join(' '));
    }
  }
  cache = { file, dataset: raw.dataset, regs, provisions, index };
  return cache;
}

const norm = (s) => String(s || '').trim().toLowerCase();

/** Jurisdiction + data-type applicability. Deterministic; returns the reason
 * either way so "Not applicable" is always documented. */
function applicability(reg, profile) {
  const juris = (profile.jurisdictions || []).map(norm);
  const hit = reg.jurisdictions.some((j) => juris.includes(norm(j)));
  if (!hit) return { applicable: false, reason: `Company profile lists no jurisdiction matching ${reg.short} (${reg.jurisdictions.join('/')}).` };
  const need = reg.appliesWhen?.dataTypes || [];
  const have = (profile.dataTypes || []).map(norm);
  if (need.length && !need.some((d) => have.includes(d))) {
    return { applicable: false, reason: `${reg.short} applies to ${need.join('/')} data; the profile declares: ${have.join(', ') || 'none'}.` };
  }
  return { applicable: true, reason: `Jurisdiction matches and profile declares ${need.join('/') || 'relevant'} data.` };
}

/** Provision retrieval with jurisdiction filter and BM25 ranking against free text. */
function searchProvisions(query, { jurisdictions = [], limit = 8 } = {}) {
  const { index, provisions } = loadRegulations();
  const jur = jurisdictions.map(norm);
  return index.search(tokens(query), 50)
    .map((r) => ({ ...r, provision: provisions.get(r.id) }))
    .filter((r) => !jur.length || r.provision.jurisdictions.some((j) => jur.includes(norm(j))))
    .slice(0, limit);
}

// -------------------------------------------------------------- documents
/** Build an FTS index of document chunks and retrieve evidence for one
 * obligation. `matchedTerms` is computed in code from the actual chunk text so
 * relevance is checkable, not just a bm25 number. */
class EvidenceStore {
  constructor(documents) {
    this.chunks = new Map();
    this.index = new Index(['text']);
    for (const d of documents) {
      if (d.status !== 'parsed') continue;
      for (const c of d.chunks) { this.chunks.set(c.id, { ...c, docName: d.name }); this.index.add(c.id, c.text); }
    }
  }
  retrieve(provision, { limit = 3, minTerms = 1 } = {}) {
    const terms = [...(provision.evidenceTerms || [])];
    const hits = this.index.search(terms, limit * 3);
    const wanted = terms.map((t) => t.toLowerCase());
    const out = [];
    for (const h of hits) {
      const chunk = this.chunks.get(h.id);
      const lower = chunk.text.toLowerCase();
      const matchedTerms = wanted.filter((t) => lower.includes(t));
      if (matchedTerms.length >= minTerms) out.push({ chunk, score: h.score, matchedTerms });
      if (out.length >= limit) break;
    }
    return out;
  }
}

module.exports = { Index, tokens, ftsQuery, loadRegulations, applicability, searchProvisions, EvidenceStore };
