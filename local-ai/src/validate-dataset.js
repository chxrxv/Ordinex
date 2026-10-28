'use strict';
// Validates regdata/regulations.json. Exit code 1 on any error. Run: node src/validate-dataset.js [file]
const fs = require('node:fs');
const config = require('./config');

const STATUSES = ['verified-official', 'unverified', 'source-unavailable', 'superseded'];
const TEXT_BASES = ['exact', 'summary', 'paraphrase'];
const OFFICIAL_HOSTS = [/(^|\.)europa\.eu$/, /(^|\.)ecfr\.gov$/, /(^|\.)gov$/, /(^|\.)gov\.in$/, /(^|\.)legislation\.gov\.uk$/, /(^|\.)nic\.in$/];

function validateDataset(data) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m);
  if (!data || typeof data !== 'object' || !data.dataset || !Array.isArray(data.regulations)) return { errors: ['Top level must have "dataset" and "regulations"[]'], warnings };
  for (const k of ['name', 'version', 'coverage', 'verificationStatus', 'updateMechanism']) if (!data.dataset[k]) err(`dataset.${k} is required`);
  const regIds = new Set(), provIds = new Set();
  for (const r of data.regulations) {
    const w = `regulation ${r.id || '(no id)'}`;
    for (const k of ['id', 'name', 'short', 'authority', 'sourceType', 'sourceUrl']) if (!r[k]) err(`${w}: ${k} is required`);
    if (!Array.isArray(r.jurisdictions) || !r.jurisdictions.length) err(`${w}: jurisdictions[] required`);
    if (!(r.penaltyExposure >= 1 && r.penaltyExposure <= 5)) err(`${w}: penaltyExposure must be 1-5`);
    if (regIds.has(r.id)) err(`${w}: duplicate id`); regIds.add(r.id);
    let host = null;
    try { const u = new URL(r.sourceUrl); if (u.protocol !== 'https:') err(`${w}: sourceUrl must be https`); host = u.hostname; } catch { err(`${w}: sourceUrl is not a valid URL`); }
    if (host && r.sourceType === 'official' && !OFFICIAL_HOSTS.some((re) => re.test(host))) err(`${w}: sourceType "official" but host ${host} is not a recognised government/EU domain`);
    const c = r.sourceCheck;
    if (!c || !STATUSES.includes(c.status)) err(`${w}: sourceCheck.status must be one of ${STATUSES.join(', ')}`);
    else {
      if (!c.checkedOn || !/^\d{4}-\d{2}-\d{2}$/.test(c.checkedOn)) err(`${w}: sourceCheck.checkedOn (YYYY-MM-DD) required`);
      if (!c.method) err(`${w}: sourceCheck.method required (how it was checked)`);
      if (c.status === 'verified-official') {
        for (const k of ['officialTextVersion', 'scope']) if (!c[k]) err(`${w}: a verified entry must record sourceCheck.${k}`);
      } else if (!c.reason) err(`${w}: a non-verified entry must record sourceCheck.reason`);
    }
    for (const p of r.provisions || []) {
      const pw = `provision ${p.id || '(no id)'}`;
      for (const k of ['id', 'ref', 'title', 'obligation', 'ownerRole']) if (!p[k]) err(`${pw}: ${k} is required`);
      if (provIds.has(p.id)) err(`${pw}: duplicate id`); provIds.add(p.id);
      if (!(p.severity >= 1 && p.severity <= 5)) err(`${pw}: severity must be 1-5`);
      if (!Array.isArray(p.evidenceTerms) || !p.evidenceTerms.length) err(`${pw}: evidenceTerms[] required`);
      if (!TEXT_BASES.includes(p.textBasis)) err(`${pw}: textBasis must be one of ${TEXT_BASES.join(', ')}`);
      if (p.textBasis !== 'exact' && c?.status === 'verified-official' && !c.scope) err(`${pw}: non-exact text under a verified source needs sourceCheck.scope`);
      if (c?.status !== 'verified-official' && p.humanReviewRequired !== true) err(`${pw}: provisions of unverified sources must set humanReviewRequired: true`);
    }
    if (!(r.provisions || []).length) err(`${w}: has no provisions`);
  }
  // A dataset may only claim a verification date if every regulation is verified.
  const allVerified = data.regulations.every((r) => r.sourceCheck?.status === 'verified-official');
  if (data.dataset.lastVerified && !allVerified) err('dataset.lastVerified is set but not every regulation is verified-official');
  if (!data.dataset.lastVerified && allVerified) warnings.push('every regulation is verified; consider setting dataset.lastVerified');
  return { errors, warnings, summary: { regulations: data.regulations.length, provisions: provIds.size, verified: data.regulations.filter((r) => r.sourceCheck?.status === 'verified-official').map((r) => r.short), unverified: data.regulations.filter((r) => r.sourceCheck?.status !== 'verified-official').map((r) => r.short) } };
}

module.exports = { validateDataset };
if (require.main === module) {
  const file = process.argv[2] || config.regulationsFile;
  let res;
  try { res = validateDataset(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { res = { errors: [`cannot read ${file}: ${e.message}`], warnings: [] }; }
  res.errors.forEach((e) => console.error('ERROR  ' + e)); res.warnings.forEach((w) => console.warn('WARN   ' + w));
  if (res.summary) console.log(JSON.stringify(res.summary));
  console.log(res.errors.length ? `FAILED: ${res.errors.length} error(s)` : 'Dataset valid');
  process.exit(res.errors.length ? 1 : 0);
}
