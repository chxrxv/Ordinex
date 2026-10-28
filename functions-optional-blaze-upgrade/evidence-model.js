function makeStableId(prefix, seed) {
  const raw = String(seed ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (raw) return `${prefix}-${raw}`;
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}`;
}

function buildSourceReference(reg = {}) {
  const sourceType = reg.sourceType || 'reference';
  const verificationStatus = reg.verificationStatus || (sourceType === 'official' ? 'Verified official source' : 'Demo/reference source');
  return {
    id: reg.id || 'unknown-source',
    name: reg.name || reg.short || 'Unnamed regulation',
    authority: reg.authority || 'Regulatory authority reference',
    sourceUrl: reg.sourceUrl || 'Source URL not disclosed in demo data',
    sourceType,
    verificationStatus,
    jurisdiction: reg.country || reg.countryCode || 'Unspecified',
    lastVerified: reg.lastVerified || reg.updated || 'Not disclosed'
  };
}

function normalizeDocumentEvidence(doc = {}) {
  const id = doc.id || `doc_${Math.random().toString(16).slice(2)}`;
  const name = doc.name || doc.title || 'Unnamed document';
  const type = doc.type || 'TXT';
  const statusValue = doc.parsingStatus || doc.status || 'unparsed';
  const rawText = typeof doc.text === 'string' ? doc.text.trim() : '';
  const extractedText = typeof doc.content === 'string' ? doc.content.trim() : rawText;
  const fileText = typeof doc.fileText === 'string' ? doc.fileText.trim() : '';
  const hasContent = Boolean(extractedText || fileText || doc.summary || doc.metadata);

  let status = 'unavailable';
  if (statusValue === 'unsupported' || type === 'unsupported') status = 'unsupported';
  else if (statusValue === 'failed' || statusValue === 'error') status = 'unavailable';
  else if (hasContent || statusValue === 'analyzed' || statusValue === 'processed' || statusValue === 'parsed') status = 'parsed';
  else if (name) status = 'unparsed';

  return {
    id,
    name,
    type,
    status,
    evidenceStatus: status === 'parsed' ? 'Parsed' : status === 'unparsed' ? 'Unparsed' : status === 'unsupported' ? 'Unsupported format' : 'Unavailable',
    contentAvailable: hasContent,
    sourceType: doc.sourceType || 'uploaded',
    verificationStatus: doc.verificationStatus || (status === 'parsed' ? 'Parsed content available' : 'No parsed content available')
  };
}

function determineComplianceStatus({ requirementStatus, applicability, evidenceAvailable, profileComplete }) {
  if (applicability === 'Not applicable') return 'Not applicable';
  if (!evidenceAvailable) return 'Insufficient evidence';
  if (!profileComplete) return 'Requires expert review';
  if (requirementStatus === 'met') return 'Compliant';
  if (requirementStatus === 'partial') return 'Partially compliant';
  if (requirementStatus === 'gap') return 'Non-compliant';
  return 'Requires expert review';
}

const SUPPORTED_LANGUAGES = {
  en: { name: 'English', supported: true, translation: true, ocr: false, retrieval: true },
  hi: { name: 'Hindi', supported: true, translation: true, ocr: false, retrieval: true },
  kn: { name: 'Kannada', supported: true, translation: true, ocr: false, retrieval: true },
  ta: { name: 'Tamil', supported: false, translation: false, ocr: false, retrieval: false },
  te: { name: 'Telugu', supported: false, translation: false, ocr: false, retrieval: false },
  bn: { name: 'Bengali', supported: false, translation: false, ocr: false, retrieval: false },
  mr: { name: 'Marathi', supported: false, translation: false, ocr: false, retrieval: false },
  de: { name: 'German', supported: true, translation: true, ocr: false, retrieval: true },
  fr: { name: 'French', supported: true, translation: true, ocr: false, retrieval: true },
  es: { name: 'Spanish', supported: true, translation: true, ocr: false, retrieval: true },
  ja: { name: 'Japanese', supported: true, translation: true, ocr: false, retrieval: true },
  zh: { name: 'Chinese', supported: true, translation: true, ocr: false, retrieval: true },
  ko: { name: 'Korean', supported: true, translation: true, ocr: false, retrieval: true },
  ar: { name: 'Arabic', supported: true, translation: true, ocr: false, retrieval: true },
  pt: { name: 'Portuguese', supported: true, translation: true, ocr: false, retrieval: true },
  und: { name: 'Undetected', supported: false, translation: false, ocr: false, retrieval: false }
};

function normalizeLanguageCode(language) {
  const raw = String(language || 'en').trim().toLowerCase();
  if (!raw) return 'en';
  const match = Object.keys(SUPPORTED_LANGUAGES).find((code) => code === raw || code === raw.slice(0, 2));
  return match || 'und';
}

function isSupportedLanguage(language) {
  const normalized = normalizeLanguageCode(language);
  return Boolean(SUPPORTED_LANGUAGES[normalized] && SUPPORTED_LANGUAGES[normalized].supported);
}

function getLanguageCapability(language) {
  const normalized = normalizeLanguageCode(language);
  return SUPPORTED_LANGUAGES[normalized] || { name: 'Unsupported', supported: false, translation: false, ocr: false, retrieval: false };
}

function detectLanguageFromText(text = '') {
  const sample = String(text || '').trim();
  if (!sample) return 'und';
  if (/[\u0900-\u097F]/.test(sample)) return 'hi';
  if (/[\u0C80-\u0CFF]/.test(sample)) return 'kn';
  if (/[\u0600-\u06FF]/.test(sample)) return 'ar';
  if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(sample)) return 'ja';
  if (/[A-Za-z]/.test(sample)) return 'en';
  return 'und';
}

function buildMultilingualEvidence(doc = {}) {
  const originalText = typeof doc.originalText === 'string' ? doc.originalText.trim() : (typeof doc.text === 'string' ? doc.text.trim() : '');
  const originalLanguage = normalizeLanguageCode(doc.originalLanguage || doc.language || detectLanguageFromText(originalText) || 'en');
  const detectedLanguage = normalizeLanguageCode(doc.detectedLanguage || detectLanguageFromText(originalText) || originalLanguage);
  const translationText = typeof doc.translationText === 'string' ? doc.translationText.trim() : '';
  const translationLanguage = normalizeLanguageCode(doc.translationLanguage || 'en');
  const translationStatus = doc.translationStatus || (translationText ? 'available' : 'unavailable');
  const translationMethod = doc.translationMethod || (translationText ? 'manual-review' : 'not-configured');

  return {
    id: doc.id || `doc_${Math.random().toString(16).slice(2)}`,
    name: doc.name || doc.title || 'Unnamed document',
    type: doc.type || 'TXT',
    originalText,
    originalLanguage,
    detectedLanguage,
    detectionMethod: doc.detectionMethod || 'heuristic-text-scan',
    translationText,
    translationLanguage,
    translationMethod,
    translationTimestamp: doc.translationTimestamp || null,
    translationStatus,
    translationVerified: Boolean(doc.translationVerified),
    sourceReferences: Array.isArray(doc.sourceReferences) ? doc.sourceReferences : [],
    documentLocation: doc.documentLocation || null,
    textLocation: doc.textLocation || null,
    reviewRequired: Boolean(doc.reviewRequired || translationStatus === 'unavailable')
  };
}

function normalizeDocumentEvidence(doc = {}) {
  const id = doc.id || `doc_${Math.random().toString(16).slice(2)}`;
  const name = doc.name || doc.title || 'Unnamed document';
  const type = doc.type || 'TXT';
  const statusValue = doc.parsingStatus || doc.status || 'unparsed';
  const rawText = typeof doc.text === 'string' ? doc.text.trim() : '';
  const extractedText = typeof doc.content === 'string' ? doc.content.trim() : rawText;
  const fileText = typeof doc.fileText === 'string' ? doc.fileText.trim() : '';
  const hasContent = Boolean(extractedText || fileText || doc.summary || doc.metadata);

  let status = 'unavailable';
  if (statusValue === 'unsupported' || type === 'unsupported') status = 'unsupported';
  else if (statusValue === 'failed' || statusValue === 'error') status = 'unavailable';
  else if (hasContent || statusValue === 'analyzed' || statusValue === 'processed' || statusValue === 'parsed') status = 'parsed';
  else if (name) status = 'unparsed';

  const multilingual = buildMultilingualEvidence({
    ...doc,
    text: rawText || extractedText || fileText,
    originalText: doc.originalText || rawText || extractedText || fileText
  });

  return {
    id,
    name,
    type,
    status,
    evidenceStatus: status === 'parsed' ? 'Parsed' : status === 'unparsed' ? 'Unparsed' : status === 'unsupported' ? 'Unsupported format' : 'Unavailable',
    contentAvailable: hasContent,
    sourceType: doc.sourceType || 'uploaded',
    verificationStatus: doc.verificationStatus || (status === 'parsed' ? 'Parsed content available' : 'No parsed content available'),
    originalText: multilingual.originalText,
    originalLanguage: multilingual.originalLanguage,
    detectedLanguage: multilingual.detectedLanguage,
    detectionMethod: multilingual.detectionMethod,
    translationText: multilingual.translationText,
    translationLanguage: multilingual.translationLanguage,
    translationMethod: multilingual.translationMethod,
    translationTimestamp: multilingual.translationTimestamp,
    translationStatus: multilingual.translationStatus,
    translationVerified: multilingual.translationVerified,
    documentLocation: multilingual.documentLocation,
    textLocation: multilingual.textLocation,
    reviewRequired: multilingual.reviewRequired,
    sourceReferences: multilingual.sourceReferences
  };
}

function buildCrossLanguageEvidenceMatch({ evidenceItems = [], sourceLanguage = 'en', documentLanguage = 'en', analysisLanguage = 'en' } = {}) {
  const supportedDocLanguage = normalizeLanguageCode(documentLanguage);
  const supportedSourceLanguage = normalizeLanguageCode(sourceLanguage);
  const targetAnalysisLanguage = normalizeLanguageCode(analysisLanguage);

  const matches = evidenceItems.map((item) => {
    const sourceText = item.originalText || item.text || item.content || '';
    const detected = normalizeLanguageCode(item.detectedLanguage || detectLanguageFromText(sourceText) || supportedDocLanguage);
    const rationale = detected === supportedSourceLanguage || detected === supportedDocLanguage
      ? 'Language aligned with the source or document context'
      : 'Language differs from the source; cross-language review or translation is required';

    return {
      id: item.id,
      language: detected,
      status: item.status || 'parsed',
      reviewRequired: item.reviewRequired || detected !== supportedSourceLanguage || detected !== supportedDocLanguage,
      rationale,
      analysisLanguage: targetAnalysisLanguage,
      sourceLanguage: supportedSourceLanguage,
      documentLanguage: supportedDocLanguage
    };
  });

  return {
    analysisLanguage: targetAnalysisLanguage,
    sourceLanguage: supportedSourceLanguage,
    documentLanguage: supportedDocLanguage,
    matches,
    unsupportedLanguageReferences: matches.filter((item) => !isSupportedLanguage(item.language))
  };
}

function buildTranslatedAssessmentReport({ snapshot = {}, reportLanguage = 'en', analysisLanguage = 'en' } = {}) {
  const safeSnapshot = snapshot || {};
  const language = normalizeLanguageCode(reportLanguage || analysisLanguage || 'en');
  const baseAssessment = safeSnapshot.assessment || []; // require same underlying assessment, not a shadowed copy
  const report = {
    reportLanguage: language,
    analysisLanguage: normalizeLanguageCode(analysisLanguage || 'en'),
    assessmentId: safeSnapshot.assessmentId || 'assessment',
    assessmentVersion: safeSnapshot.version || 1,
    score: safeSnapshot.riskScore ?? safeSnapshot.overallRisk ?? safeSnapshot.score ?? 0,
    findingIds: (baseAssessment || []).map((item) => item.id),
    summary: `Assessment represented in ${SUPPORTED_LANGUAGES[language]?.name || 'the selected'} language using the same underlying evidence snapshot.`,
    isTranslated: language !== (normalizeLanguageCode(safeSnapshot.analysisLanguage || 'en')),
    originalLanguagePreserved: true,
    evidenceReferences: (baseAssessment || []).map((item) => ({ id: item.id, source: item.authority || item.sourceUrl || 'Source not disclosed' }))
  };
  return report;
}

function validateAssessmentConsistency({ snapshot = {}, findings = [], riskAssessments = [], reports = [] } = {}) {
  const issues = [];
  const findingsList = Array.isArray(findings) ? findings : Array.isArray(snapshot.findings) ? snapshot.findings : [];
  const riskList = Array.isArray(riskAssessments) ? riskAssessments : Array.isArray(snapshot.riskAssessments) ? snapshot.riskAssessments : [];
  const baselineScores = riskList.map((risk) => Number(risk.score || 0));
  const reportScores = reports.map((report) => Number(report.score || report.riskScore || 0));

  findingsList.forEach((finding) => {
    if (!finding || !finding.id) issues.push({ type: 'missing-finding-id', message: 'A finding record is missing a stable ID.' });
    if (finding && finding.obligationId && !finding.obligationId.trim()) issues.push({ type: 'empty-obligation-reference', id: finding.id, message: 'Finding references an empty obligation ID.' });
    if (finding && finding.evidenceIds && !Array.isArray(finding.evidenceIds)) issues.push({ type: 'bad-evidence-reference', id: finding.id, message: 'Finding evidenceIds must be an array.' });
  });

  riskList.forEach((risk) => {
    if (!risk || !risk.id) issues.push({ type: 'missing-risk-id', message: 'A risk assessment is missing a stable ID.' });
    if (risk && risk.findingId && !risk.findingId.trim()) issues.push({ type: 'empty-risk-finding', id: risk.id, message: 'Risk assessment references an empty finding ID.' });
  });

  if (reportScores.length && baselineScores.length && reportScores.some((score) => baselineScores.some((baseline) => baseline !== score))) {
    issues.push({ type: 'language-report-inconsistency', message: 'Report risk score differs from the underlying assessment score across language versions.' });
  }

  return { valid: issues.length === 0, issues };
}

function buildFindingTraceabilityGraph({
  organization = {},
  regulations = [],
  documents = [],
  findings = [],
  riskAssessment = [],
  assessmentId = 'assessment'
} = {}) {
  const normalizedDocuments = Array.isArray(documents) ? documents.map(normalizeDocumentEvidence) : [];
  const normalizedFindings = Array.isArray(findings) ? findings : [];

  const organizationId = organization.id || makeStableId('org', organization.name || 'organization');
  const sourceRecords = (Array.isArray(regulations) ? regulations : []).map((reg, index) => {
    const source = buildSourceReference(reg);
    const sourceId = reg.id || source.id || makeStableId('source', reg.short || reg.name || index + 1);
    return {
      id: sourceId,
      type: 'source',
      ...source,
      organizationId
    };
  });

  const provisionRecords = [];
  const obligationRecords = [];
  const sourceIndex = new Map(sourceRecords.map((source) => [source.id, source]));

  sourceRecords.forEach((source, sourceIndexPosition) => {
    const reg = Array.isArray(regulations) ? regulations[sourceIndexPosition] || {} : {};
    const requirementList = Array.isArray(reg.requirements) ? reg.requirements : [];

    requirementList.forEach((requirement, requirementIndex) => {
      const provisionId = requirement.provisionId || `${source.id}-prov-${requirementIndex + 1}`;
      const obligationId = requirement.id || `${source.id}-ob-${requirementIndex + 1}`;

      provisionRecords.push({
        id: provisionId,
        type: 'provision',
        sourceId: source.id,
        regulationId: source.id,
        title: requirement.title || `Provision ${requirementIndex + 1}`,
        description: requirement.desc || requirement.summary || 'Requirement description not supplied',
        organizationId
      });

      obligationRecords.push({
        id: obligationId,
        type: 'obligation',
        sourceId: source.id,
        regulationId: source.id,
        provisionId,
        title: requirement.title || `Requirement ${requirementIndex + 1}`,
        status: determineComplianceStatus({
          requirementStatus: requirement.status === 'met' ? 'met' : requirement.status === 'partial' ? 'partial' : requirement.status === 'gap' ? 'gap' : 'unknown',
          applicability: requirement.applicability || 'Applicable',
          evidenceAvailable: normalizedDocuments.some((doc) => doc.status === 'parsed'),
          profileComplete: Boolean(organization.name || organization.plan || organization.seats || organization.seatsUsed)
        }),
        rawStatus: requirement.status || 'unknown',
        description: requirement.desc || requirement.summary || 'Requirement description not supplied',
        authority: source.authority,
        sourceUrl: source.sourceUrl,
        sourceType: source.sourceType,
        verificationStatus: source.verificationStatus,
        organizationId
      });
    });
  });

  const obligationIndex = new Map(obligationRecords.map((obligation) => [obligation.id, obligation]));
  const evidenceRecords = normalizedDocuments.map((doc) => ({
    ...doc,
    type: 'evidence',
    organizationId
  }));
  const evidenceIndex = new Map(evidenceRecords.map((doc) => [doc.id, doc]));

  const findingRecords = normalizedFindings.map((finding, index) => {
    const findingId = finding.id || makeStableId('finding', finding.title || index + 1);
    const sourceId = finding.sourceId || sourceRecords.find((source) => {
      return source.id === finding.regulationId || source.name === finding.regulation || source.name === finding.reg || source.id === finding.reg;
    })?.id || (sourceRecords[0] ? sourceRecords[0].id : null);

    const matchedObligation = finding.obligationId || finding.requirementId
      ? obligationIndex.get(finding.obligationId || finding.requirementId)
      : obligationRecords.find((obligation) => {
          const candidateTitle = (finding.obligationTitle || finding.requirementTitle || finding.title || '').toLowerCase();
          return candidateTitle && obligation.title && obligation.title.toLowerCase().includes(candidateTitle);
        });

    const findingEvidenceIds = Array.isArray(finding.evidenceIds)
      ? finding.evidenceIds
      : Array.isArray(finding.evidence)
        ? finding.evidence.map((entry) => entry && entry.id ? entry.id : String(entry))
        : (
            finding.documentId || finding.evidenceId ? [finding.documentId || finding.evidenceId] : []
          );

    const remediationId = finding.remediationId || makeStableId('remediation', findingId);
    const riskId = finding.riskId || makeStableId('risk', findingId);

    return {
      id: findingId,
      type: 'finding',
      title: finding.title || `Finding ${index + 1}`,
      status: finding.status || 'Open',
      severity: finding.severity || 'Medium',
      sourceId,
      regulationId: finding.regulationId || sourceId,
      obligationId: matchedObligation ? matchedObligation.id : finding.obligationId || finding.requirementId || null,
      evidenceIds: findingEvidenceIds.filter(Boolean),
      riskId,
      remediationId,
      recommendation: finding.recommendation || 'Document the control owner and evidence for this obligation',
      evidenceSummary: finding.evidenceSummary || finding.summary || finding.description || 'Evidence summary not provided',
      organizationId
    };
  });

  const findingIndex = new Map(findingRecords.map((finding) => [finding.id, finding]));

  const riskRecords = (Array.isArray(riskAssessment) && riskAssessment.length ? riskAssessment : findingRecords.map((finding) => ({
    id: finding.riskId,
    findingId: finding.id,
    score: 50,
    level: finding.status === 'Non-compliant' ? 'High Risk' : finding.status === 'Partially compliant' ? 'Medium Risk' : 'Low Risk'
  }))).map((risk, index) => {
    const findingId = risk.findingId || findingRecords[index]?.id || makeStableId('finding', index + 1);
    const score = Number(risk.score ?? risk.riskScore ?? 0);
    const level = risk.level || (score >= 75 ? 'High Risk' : score >= 45 ? 'Medium Risk' : 'Low Risk');
    return {
      id: risk.id || makeStableId('risk', findingId),
      type: 'risk',
      findingId,
      score,
      level,
      summary: risk.summary || 'Risk derived from the linked finding and evidence record',
      organizationId
    };
  });

  const remediationRecords = findingRecords.map((finding, index) => {
    const record = {
      id: finding.remediationId || makeStableId('remediation', finding.id),
      type: 'remediation',
      findingId: finding.id,
      action: finding.recommendation || 'Document the control owner and evidence for this obligation',
      owner: 'Compliance team',
      status: 'planned',
      organizationId
    };

    if (Array.isArray(riskAssessment) && riskAssessment[index]) {
      record.riskId = riskAssessment[index].id || riskRecords[index]?.id || null;
    }
    return record;
  });

  const traceabilityGraph = {
    assessment: {
      id: assessmentId,
      type: 'assessment',
      label: assessmentId,
      organizationId,
      createdAt: new Date().toISOString(),
      findingsCount: findingRecords.length,
      sourceCount: sourceRecords.length,
      obligationCount: obligationRecords.length,
      evidenceCount: evidenceRecords.length
    },
    organization: {
      id: organizationId,
      type: 'organization',
      name: organization.name || 'Unnamed organization',
      plan: organization.plan || 'Demo',
      country: organization.country || 'Unspecified'
    },
    sources: sourceRecords,
    provisions: provisionRecords,
    obligations: obligationRecords,
    evidence: evidenceRecords,
    findings: findingRecords,
    riskAssessments: riskRecords,
    remediations: remediationRecords,
    registry: {
      sources: sourceRecords.map((source) => source.id),
      provisions: provisionRecords.map((entry) => entry.id),
      obligations: obligationRecords.map((entry) => entry.id),
      evidence: evidenceRecords.map((entry) => entry.id),
      findings: findingRecords.map((entry) => entry.id),
      risks: riskRecords.map((entry) => entry.id),
      remediations: remediationRecords.map((entry) => entry.id)
    },
    summary: {
      totalSources: sourceRecords.length,
      totalProvisions: provisionRecords.length,
      totalObligations: obligationRecords.length,
      totalEvidence: evidenceRecords.length,
      totalFindings: findingRecords.length,
      totalRisks: riskRecords.length,
      totalRemediations: remediationRecords.length
    }
  };

  return traceabilityGraph;
}

function buildFindingTraceability(assessmentInput) {
  return buildFindingTraceabilityGraph(assessmentInput);
}

function validateTraceabilityGraph(graph = {}) {
  const issues = [];
  const arrays = [
    { name: 'sources', items: Array.isArray(graph.sources) ? graph.sources : [] },
    { name: 'provisions', items: Array.isArray(graph.provisions) ? graph.provisions : [] },
    { name: 'obligations', items: Array.isArray(graph.obligations) ? graph.obligations : [] },
    { name: 'evidence', items: Array.isArray(graph.evidence) ? graph.evidence : [] },
    { name: 'findings', items: Array.isArray(graph.findings) ? graph.findings : [] },
    { name: 'riskAssessments', items: Array.isArray(graph.riskAssessments) ? graph.riskAssessments : [] },
    { name: 'remediations', items: Array.isArray(graph.remediations) ? graph.remediations : [] }
  ];

  arrays.forEach(({ name, items }) => {
    const seen = new Set();
    items.forEach((item) => {
      if (!item || !item.id) {
        issues.push({ type: 'missing-id', scope: name, message: `A ${name.slice(0, -1)} record is missing an ID.` });
        return;
      }
      if (seen.has(item.id)) {
        issues.push({ type: 'duplicate-id', scope: name, id: item.id, message: `Duplicate ID detected in ${name}: ${item.id}` });
      }
      seen.add(item.id);
    });
  });

  const sourceMap = new Map((Array.isArray(graph.sources) ? graph.sources : []).map((source) => [source.id, source]));
  const provisionMap = new Map((Array.isArray(graph.provisions) ? graph.provisions : []).map((provision) => [provision.id, provision]));
  const obligationMap = new Map((Array.isArray(graph.obligations) ? graph.obligations : []).map((obligation) => [obligation.id, obligation]));
  const evidenceMap = new Map((Array.isArray(graph.evidence) ? graph.evidence : []).map((doc) => [doc.id, doc]));
  const findingMap = new Map((Array.isArray(graph.findings) ? graph.findings : []).map((finding) => [finding.id, finding]));

  (Array.isArray(graph.provisions) ? graph.provisions : []).forEach((provision) => {
    if (provision.sourceId && !sourceMap.has(provision.sourceId)) {
      issues.push({ type: 'dangling-reference', scope: 'provisions', id: provision.id, message: `Provision ${provision.id} references missing source ${provision.sourceId}` });
    }
    if (provision.regulationId && !sourceMap.has(provision.regulationId)) {
      issues.push({ type: 'dangling-reference', scope: 'provisions', id: provision.id, message: `Provision ${provision.id} references missing regulation ${provision.regulationId}` });
    }
  });

  (Array.isArray(graph.obligations) ? graph.obligations : []).forEach((obligation) => {
    if (obligation.sourceId && !sourceMap.has(obligation.sourceId)) {
      issues.push({ type: 'dangling-reference', scope: 'obligations', id: obligation.id, message: `Obligation ${obligation.id} references missing source ${obligation.sourceId}` });
    }
    if (obligation.provisionId && !provisionMap.has(obligation.provisionId)) {
      issues.push({ type: 'dangling-reference', scope: 'obligations', id: obligation.id, message: `Obligation ${obligation.id} references missing provision ${obligation.provisionId}` });
    }
  });

  (Array.isArray(graph.findings) ? graph.findings : []).forEach((finding) => {
    if (finding.sourceId && !sourceMap.has(finding.sourceId)) {
      issues.push({ type: 'dangling-reference', scope: 'findings', id: finding.id, message: `Finding ${finding.id} references missing source ${finding.sourceId}` });
    }
    if (finding.obligationId && !obligationMap.has(finding.obligationId)) {
      issues.push({ type: 'dangling-reference', scope: 'findings', id: finding.id, message: `Finding ${finding.id} references missing obligation ${finding.obligationId}` });
    }
    if (Array.isArray(finding.evidenceIds)) {
      finding.evidenceIds.forEach((evidenceId) => {
        if (!evidenceMap.has(evidenceId)) {
          issues.push({ type: 'dangling-reference', scope: 'findings', id: finding.id, message: `Finding ${finding.id} references missing evidence ${evidenceId}` });
        }
      });
    }
  });

  (Array.isArray(graph.riskAssessments) ? graph.riskAssessments : []).forEach((riskRecord) => {
    if (riskRecord.findingId && !findingMap.has(riskRecord.findingId)) {
      issues.push({ type: 'dangling-reference', scope: 'riskAssessments', id: riskRecord.id, message: `Risk record ${riskRecord.id} references missing finding ${riskRecord.findingId}` });
    }
  });

  (Array.isArray(graph.remediations) ? graph.remediations : []).forEach((remediation) => {
    if (remediation.findingId && !findingMap.has(remediation.findingId)) {
      issues.push({ type: 'dangling-reference', scope: 'remediations', id: remediation.id, message: `Remediation ${remediation.id} references missing finding ${remediation.findingId}` });
    }
  });

  const summary = {
    totalIssues: issues.length,
    totalSources: (Array.isArray(graph.sources) ? graph.sources : []).length,
    totalProvisions: (Array.isArray(graph.provisions) ? graph.provisions : []).length,
    totalObligations: (Array.isArray(graph.obligations) ? graph.obligations : []).length,
    totalEvidence: (Array.isArray(graph.evidence) ? graph.evidence : []).length,
    totalFindings: (Array.isArray(graph.findings) ? graph.findings : []).length,
    totalRisks: (Array.isArray(graph.riskAssessments) ? graph.riskAssessments : []).length,
    totalRemediations: (Array.isArray(graph.remediations) ? graph.remediations : []).length
  };

  return {
    valid: issues.length === 0,
    issues,
    summary
  };
}

function scoreAssessmentRisk(assessment = []) {
  const entries = Array.isArray(assessment)
    ? assessment
    : Array.isArray(assessment?.findings)
      ? assessment.findings
      : Array.isArray(assessment?.assessment?.findings)
        ? assessment.assessment.findings
        : [];

  if (!Array.isArray(entries) || entries.length === 0) {
    return { score: 0, level: 'Low Risk', reasons: ['No assessment evidence loaded'] };
  }

  const nonCompliant = entries.filter((item) => item.status === 'Non-compliant').length;
  const insufficient = entries.filter((item) => item.status === 'Insufficient evidence').length;
  const partial = entries.filter((item) => item.status === 'Partially compliant').length;
  const applicable = entries.filter((item) => item.applicability === 'Applicable').length;
  const total = applicable || entries.length;

  const score = Math.min(100, Math.round((nonCompliant * 38 + insufficient * 30 + partial * 14 + Math.max(0, total - nonCompliant - insufficient - partial) * 4) / Math.max(1, total) * 100));

  let level = 'Low Risk';
  if (score >= 75) level = 'High Risk';
  else if (score >= 45) level = 'Medium Risk';

  return {
    score,
    level,
    reasons: [
      nonCompliant ? `${nonCompliant} non-compliant obligations` : 'No material non-compliance flagged',
      insufficient ? `${insufficient} obligations lack evidence` : 'Sufficient evidence for the assessed obligations',
      partial ? `${partial} partially compliant obligations` : 'No partial compliance findings'
    ]
  };
}

module.exports = {
  makeStableId,
  buildSourceReference,
  normalizeDocumentEvidence,
  determineComplianceStatus,
  SUPPORTED_LANGUAGES,
  normalizeLanguageCode,
  isSupportedLanguage,
  getLanguageCapability,
  detectLanguageFromText,
  buildMultilingualEvidence,
  buildCrossLanguageEvidenceMatch,
  buildTranslatedAssessmentReport,
  validateAssessmentConsistency,
  buildFindingTraceabilityGraph,
  buildFindingTraceability,
  validateTraceabilityGraph,
  scoreAssessmentRisk
};
