'use strict';
const { hashSnapshot } = require('./pipeline');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Reports are rendered ONLY from a saved snapshot; the hash is re-checked so a
 * tampered or inconsistent snapshot is refused rather than reported. */
function assertSnapshot(s) {
  if (!s || s.hash !== hashSnapshot(s)) throw new Error('Snapshot integrity check failed; refusing to generate a report.');
  const ids = new Set(s.findings.map((f) => f.id));
  for (const r of s.risks) if (!ids.has(r.findingId)) throw new Error('Snapshot inconsistent: risk references unknown finding.');
}

function toMarkdown(s) {
  assertSnapshot(s);
  const L = [];
  L.push(`# Ordinex Compliance Assessment ${s.id}`, '', `- Assessment date: ${s.createdAt}`, `- Snapshot hash (sha256): \`${s.hash}\``, `- Model: ${s.model.name} via ${s.model.location}; processor: ${s.model.processor}; ctx ${s.model.numCtx}; ${s.model.stats.calls} calls`, `- Regulatory dataset: ${s.dataset.name} v${s.dataset.version}`, `- Dataset coverage: ${s.dataset.coverage}`, `- Dataset last verified: ${s.dataset.lastVerified || 'never — unverified'}`, `- Dataset status: ${s.dataset.verificationStatus}`, '');
  L.push('## Overview', '', `Overall risk: ${s.riskSummary.overall ?? 'n/a'} (${s.riskSummary.level}) — ${s.riskSummary.formula || s.riskSummary.note}`, '', Object.entries(s.counts).map(([k, v]) => `- ${k}: ${v}`).join('\n'), `- Traceability valid: ${s.traceability.valid} (${s.traceability.issues.length} issues)`, '');
  L.push('## Documents', '', ...s.documents.map((d) => `- ${d.name} [${d.type}] — ${d.status}${d.message ? ` (${d.message})` : ''}${d.language ? `, language ${d.language}` : ''}`), '');
  L.push('## Findings', '');
  for (const f of s.findings) {
    const r = s.risks.find((x) => x.findingId === f.id);
    const src = s.sources.find((x) => x.id === f.sourceId);
    L.push(`### ${f.title}`, `- Status: **${f.status}**${f.reviewRequired ? ' — HUMAN REVIEW REQUIRED' : ''}`, `- Requirement type: ${f.requirementType}`, `- Source: ${src.name} — ${src.sourceUrl} (source check: ${src.sourceCheck.status}, ${src.sourceCheck.checkedOn}; provision wording: ${(s.provisions.find((x) => x.id === f.provisionId) || {}).textBasis})`, `- Risk: ${r.score} (${r.level})${r.uncertain ? ' — uncertain: evidence gap, not a confirmed violation' : ''}`, `- Reasoning (model, validated): ${f.reasoning}`);
    if (f.evidence.length) L.push('- Evidence:', ...f.evidence.map((e) => `  - ${e.docName} ${e.ref}: "${e.quote}"`));
    else L.push('- Evidence: none located/verified');
    if (f.reviewReasons.length) L.push(`- Review reasons: ${f.reviewReasons.join(' | ')}`);
    if (f.flags.length) L.push(`- Validation flags: ${f.flags.join(', ')}`);
    L.push('');
  }
  L.push('## Remediation (recommendations, not completed work)', '');
  for (const m of s.remediations) L.push(`### ${m.gap}`, `- Basis: ${m.regulatoryBasis}`, `- Action: ${m.action}`, `- Why: ${m.whyItMatters}`, `- Priority: ${m.priority} (${m.priorityBasis})`, `- Suggested owner: ${m.suggestedOwnerRole}`, `- Suggested timeline: ${m.suggestedTimeline} — ${m.timelineNote}`, `- Statutory deadline: ${m.statutoryDeadline || 'none recorded in dataset'}`, `- Verification: ${m.verificationSteps.join('; ')}`, `- Remaining uncertainty: ${m.remainingUncertainty || 'not stated'}`, `- Status: ${m.status}`, '');
  if (s.notApplicable.length) L.push('## Not applicable', '', ...s.notApplicable.map((n) => `- ${n.short}: ${n.reason}`), '');
  L.push('## Limitations', '', ...s.limitations.map((l) => `- ${l}`), '');
  return L.join('\n');
}

function toHtml(s) {
  const md = toMarkdown(s);
  const body = esc(md).replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>').replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/^- (.*)$/gm, '<li>$1</li>').replace(/\n{2,}/g, '<br>');
  return `<!doctype html><meta charset="utf-8"><title>Ordinex report ${esc(s.id)}</title><style>body{font:14px/1.5 system-ui;max-width:900px;margin:2rem auto;padding:0 1rem}li{margin:2px 0}</style>${body}`;
}

module.exports = { toMarkdown, toHtml, assertSnapshot };
