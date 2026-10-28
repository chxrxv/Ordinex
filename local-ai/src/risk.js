'use strict';
/**
 * Deterministic risk scoring. The model never supplies a number.
 *
 *   likelihood  = f(status)            Non-compliant 1.0 | Partially compliant 0.6
 *                                      Insufficient evidence 0.4 | Compliant 0.05
 *                                      (Not applicable -> no risk record)
 *   impactBase  = 0.5*(severity/5) + 0.3*(penaltyExposure/5) + 0.2*(dataSensitivity/5)
 *   score       = round(100 * likelihood * impactBase)          range 0..100
 *
 *   severity         1-5, per provision in the dataset (authors' judgement; unverified)
 *   penaltyExposure  1-5, per regulation in the dataset (authors' judgement; unverified)
 *   dataSensitivity  from company profile: 5 if special/health/financial data declared,
 *                    4 if >100k data subjects, 3 otherwise (personal data baseline)
 *
 * Levels: >=60 High, 30-59 Medium, <30 Low.
 * "Insufficient evidence" gets 0.4 because the gap is unproven, not proven;
 * it is flagged `uncertain: true` so reports never present it as a confirmed breach.
 * These weights are assumptions, not calibrated against real enforcement data.
 */
const LIKELIHOOD = { 'Non-compliant': 1.0, 'Partially compliant': 0.6, 'Insufficient evidence': 0.4, 'Compliant': 0.05 };
const FORMULA_VERSION = 'risk-v1';

function dataSensitivity(profile = {}) {
  const types = (profile.dataTypes || []).map((d) => String(d).toLowerCase());
  if (types.some((t) => ['health', 'special', 'financial', 'biometric', 'children'].includes(t))) return 5;
  if (Number(profile.dataSubjects) > 100000) return 4;
  return 3;
}

function levelFor(score) { return score >= 60 ? 'High' : score >= 30 ? 'Medium' : 'Low'; }

function scoreFinding({ status, severity, penaltyExposure, profile }) {
  if (!(status in LIKELIHOOD)) return null;
  const clamp = (n) => Math.min(5, Math.max(1, Number(n) || 3));
  const impact = 0.5 * (clamp(severity) / 5) + 0.3 * (clamp(penaltyExposure) / 5) + 0.2 * (dataSensitivity(profile) / 5);
  const score = Math.round(100 * LIKELIHOOD[status] * impact);
  return {
    score, level: levelFor(score), formula: FORMULA_VERSION,
    factors: { likelihood: LIKELIHOOD[status], severity: clamp(severity), penaltyExposure: clamp(penaltyExposure), dataSensitivity: dataSensitivity(profile), impactBase: Number(impact.toFixed(3)) },
    uncertain: status === 'Insufficient evidence',
  };
}

/** Overall = max finding score blended with mean, so a single critical gap is
 * not averaged away. Counts only; no invented percentages. */
function summarize(risks) {
  if (!risks.length) return { overall: null, level: 'Not assessed', note: 'No applicable obligations were assessed.' };
  const scores = risks.map((r) => r.score);
  const overall = Math.round(0.6 * Math.max(...scores) + 0.4 * (scores.reduce((a, b) => a + b, 0) / scores.length));
  return { overall, level: levelFor(overall), formula: 'overall = round(0.6*max + 0.4*mean of finding scores)' };
}

/** Suggested internal target, clearly NOT a statutory deadline. */
function suggestedTimeline(level) {
  return { High: 'within 30 days', Medium: 'within 90 days', Low: 'within 180 days' }[level];
}
const PRIORITY = { High: 'P1', Medium: 'P2', Low: 'P3' };

module.exports = { scoreFinding, summarize, levelFor, suggestedTimeline, PRIORITY, LIKELIHOOD, FORMULA_VERSION, dataSensitivity };
