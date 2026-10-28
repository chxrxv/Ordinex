const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSourceReference,
  normalizeDocumentEvidence,
  determineComplianceStatus,
  normalizeLanguageCode,
  isSupportedLanguage,
  detectLanguageFromText,
  buildMultilingualEvidence,
  buildCrossLanguageEvidenceMatch,
  buildTranslatedAssessmentReport,
  validateAssessmentConsistency,
  buildFindingTraceabilityGraph,
  validateTraceabilityGraph,
  scoreAssessmentRisk
} = require('../evidence-model.js');

test('buildSourceReference marks official sources as verified sources', () => {
  const source = buildSourceReference({
    id: 'reg_gdpr',
    short: 'GDPR',
    name: 'General Data Protection Regulation',
    country: 'Germany',
    sourceType: 'official',
    authority: 'European Data Protection Board',
    sourceUrl: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj'
  });

  assert.equal(source.sourceType, 'official');
  assert.equal(source.verificationStatus, 'Verified official source');
  assert.equal(source.authority, 'European Data Protection Board');
});

test('normalizeDocumentEvidence tracks unsupported and unavailable content separately', () => {
  const parsed = normalizeDocumentEvidence({ id: 'd1', name: 'policy.pdf', type: 'PDF', content: 'policy text', status: 'processed' });
  const unsupported = normalizeDocumentEvidence({ id: 'd2', name: 'image.heic', type: 'unsupported', status: 'unsupported' });
  const missing = normalizeDocumentEvidence({ id: 'd3', name: 'notes.txt', type: 'TXT', status: 'unparsed' });

  assert.equal(parsed.status, 'parsed');
  assert.equal(parsed.evidenceStatus, 'Parsed');
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(missing.status, 'unparsed');
});

test('determineComplianceStatus preserves explicit uncertainty states', () => {
  assert.equal(determineComplianceStatus({ requirementStatus: 'gap', applicability: 'Applicable', evidenceAvailable: true, profileComplete: true }), 'Non-compliant');
  assert.equal(determineComplianceStatus({ requirementStatus: 'partial', applicability: 'Applicable', evidenceAvailable: false, profileComplete: true }), 'Insufficient evidence');
  assert.equal(determineComplianceStatus({ requirementStatus: 'met', applicability: 'Not applicable', evidenceAvailable: false, profileComplete: true }), 'Not applicable');
  assert.equal(determineComplianceStatus({ requirementStatus: 'gap', applicability: 'Applicable', evidenceAvailable: true, profileComplete: false }), 'Requires expert review');
});

test('language helpers support the required core languages and reject unsupported identifiers', () => {
  assert.equal(normalizeLanguageCode('EN'), 'en');
  assert.equal(normalizeLanguageCode('hi'), 'hi');
  assert.equal(normalizeLanguageCode('kn'), 'kn');
  assert.equal(normalizeLanguageCode('xx'), 'und');
  assert.equal(isSupportedLanguage('hi'), true);
  assert.equal(isSupportedLanguage('ta'), false);
  assert.equal(detectLanguageFromText('यह दस्तावेज़ डेटा सुरक्षा का पालन करता है।'), 'hi');
  assert.equal(detectLanguageFromText('ಆನ್ಲೈನ್ ಪ್ರಕ್ರಿಯೆಗಳನ್ನು securely monitor ಮಾಡಬೇಕು.'), 'kn');
});

test('multilingual evidence preserves the original text and marks missing translations as unavailable', () => {
  const evidence = buildMultilingualEvidence({
    id: 'e1',
    name: 'policy-hi.pdf',
    type: 'PDF',
    originalText: 'उपयोगकर्ता डेटा का सुरक्षित संरक्षण आवश्यक है।',
    originalLanguage: 'hi',
    detectedLanguage: 'hi'
  });

  assert.equal(evidence.originalText, 'उपयोगकर्ता डेटा का सुरक्षित संरक्षण आवश्यक है।');
  assert.equal(evidence.originalLanguage, 'hi');
  assert.equal(evidence.translationStatus, 'unavailable');
  assert.equal(evidence.reviewRequired, true);
});

test('cross-language matching keeps the original evidence references and flags review requirements', () => {
  const match = buildCrossLanguageEvidenceMatch({
    evidenceItems: [{
      id: 'doc-1',
      originalText: 'नियमित रूप से डेटा सुरक्षा मूल्यांकन किया जाता है।',
      detectedLanguage: 'hi',
      status: 'parsed',
      reviewRequired: false
    }],
    sourceLanguage: 'en',
    documentLanguage: 'hi',
    analysisLanguage: 'en'
  });

  assert.equal(match.matches[0].language, 'hi');
  assert.equal(match.matches[0].reviewRequired, true);
  assert.equal(match.analysisLanguage, 'en');
});

test('buildFindingTraceabilityGraph links findings to source, obligation, evidence and remediation records', () => {
  const graph = buildFindingTraceabilityGraph({
    organization: { id: 'org-1', name: 'Acme', plan: 'Enterprise' },
    regulations: [{
      id: 'gdpr-1',
      short: 'GDPR',
      name: 'General Data Protection Regulation',
      sourceType: 'official',
      authority: 'European Data Protection Board',
      sourceUrl: 'https://example.com/gdpr',
      requirements: [{
        id: 'req-1',
        title: 'Data subject request handling',
        desc: 'Respond to requests within the required time window.',
        status: 'gap',
        applicability: 'Applicable'
      }]
    }],
    documents: [{ id: 'doc-1', name: 'privacy-policy.pdf', content: 'We respond to requests within 30 days.', status: 'processed' }],
    findings: [{
      id: 'finding-1',
      title: 'No DSAR workflow',
      status: 'Non-compliant',
      severity: 'High',
      regulationId: 'gdpr-1',
      requirementId: 'req-1',
      evidenceIds: ['doc-1'],
      recommendation: 'Implement a documented DSAR workflow and retrain the privacy team.'
    }],
    riskAssessment: [{ id: 'risk-1', findingId: 'finding-1', score: 82, level: 'High Risk' }]
  });

  assert.equal(graph.findings[0].sourceId, 'gdpr-1');
  assert.equal(graph.findings[0].obligationId, 'req-1');
  assert.deepEqual(graph.findings[0].evidenceIds, ['doc-1']);
  assert.equal(graph.riskAssessments[0].findingId, 'finding-1');
  assert.equal(graph.remediations[0].findingId, 'finding-1');
  assert.equal(validateTraceabilityGraph(graph).valid, true);
});

test('validateTraceabilityGraph flags dangling references and duplicate IDs', () => {
  const graph = buildFindingTraceabilityGraph({
    organization: { name: 'Acme' },
    regulations: [{
      id: 'source-1',
      short: 'GDPR',
      name: 'GDPR',
      requirements: [{ id: 'ob-1', title: 'Recording consent', status: 'met' }]
    }],
    findings: [{
      id: 'finding-1',
      title: 'Consent issue',
      status: 'Non-compliant',
      sourceId: 'source-1',
      obligationId: 'missing-obligation',
      evidenceIds: ['missing-doc'],
      recommendation: 'Review consent evidence'
    }],
    riskAssessment: [{ id: 'risk-1', findingId: 'missing-finding', score: 40 }]
  });

  const result = validateTraceabilityGraph({
    ...graph,
    findings: [
      ...graph.findings,
      { ...graph.findings[0], id: 'finding-1' }
    ]
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.message.includes('missing obligation')));
  assert.ok(result.issues.some((issue) => issue.message.includes('missing evidence')));
  assert.ok(result.issues.some((issue) => issue.type === 'duplicate-id'));
});

test('translated reports preserve the same underlying risk and evidence traceability', () => {
  const snapshot = {
    assessmentId: 'assessment-1',
    riskScore: 78,
    analysisLanguage: 'en',
    assessment: [{ id: 'obs-1', authority: 'GDPR authority', sourceUrl: 'https://example.com/obs-1' }]
  };

  const englishReport = buildTranslatedAssessmentReport({ snapshot, reportLanguage: 'en', analysisLanguage: 'en' });
  const hindiReport = buildTranslatedAssessmentReport({ snapshot, reportLanguage: 'hi', analysisLanguage: 'en' });
  const consistency = validateAssessmentConsistency({
    snapshot,
    findings: [{ id: 'finding-1', obligationId: 'obs-1', evidenceIds: ['doc-1'] }],
    riskAssessments: [{ id: 'risk-1', findingId: 'finding-1', score: 78 }],
    reports: [englishReport, hindiReport]
  });

  assert.equal(englishReport.score, 78);
  assert.equal(hindiReport.score, 78);
  assert.equal(consistency.valid, true);
});

test('scoreAssessmentRisk creates a deterministic risk score from evidence states', () => {
  const result = scoreAssessmentRisk([
    { status: 'Non-compliant', applicability: 'Applicable' },
    { status: 'Non-compliant', applicability: 'Applicable' },
    { status: 'Partially compliant', applicability: 'Applicable' },
    { status: 'Insufficient evidence', applicability: 'Applicable' },
    { status: 'Compliant', applicability: 'Applicable' }
  ]);

  assert.equal(result.level, 'High Risk');
  assert.ok(result.score >= 70);
  assert.ok(Array.isArray(result.reasons));
});
