'use strict';

const { completeJson } = require('./model-client');
const { loadPrompt } = require('./prompt-loader');
const { normalizeHex } = require('./issue-parser');
const { logProgress, elapsedSeconds } = require('./progress');
const {
  normalizeMappingEntries,
  normalizeObjectType,
  normalizeUnit
} = require('../../scripts/lib/validation/requested-mapping');

function evidencePayload(intake, source) {
  return {
    issue: {
      vendor: intake.vendor,
      model: intake.model,
      lorawanClass: intake.lorawanClass,
      lorawanVersion: intake.lorawanVersion,
      fPortStatus: intake.fPortStatus || 'explicit',
      uplinkExamples: intake.uplinkExamples,
      uplinkDescription: intake.uplinkText,
      providedDecoder: intake.decoderSource || null,
      decoderOrigin: intake.decoderOrigin || (intake.decoderSource ? 'issue-inline' : null),
      decoderUrl: intake.decoderUrl || null,
      decoderAuthority: intake.decoderAuthority || 'supporting',
      decoderAuthorityReason: intake.decoderAuthorityReason || null,
      decoderRequest: intake.decoderSource ? null : intake.decoder,
      bacnetMapping: intake.bacnetMapping,
      bacnetMappingStatus: intake.bacnetMappingStatus || 'explicit',
      bacnetMappingReferences: intake.bacnetMappingReferences || []
    },
    officialDocument: {
      url: source.url,
      type: source.type,
      pages: source.pages,
      text: source.type === 'decoder' ? null : source.text
    }
  };
}

function canonicalEvidenceUnit(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const normalized = normalizeUnit(value);
  if (normalized) return normalized;
  const noUnitMarker = String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['unit', 'nounit', 'nounits', 'none', 'na'].includes(noUnitMarker)) return null;
  return String(value).trim();
}

function canonicalEndianness(value) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z]/g, '');
  if (normalized === 'be' || normalized === 'big' || normalized === 'bigendian') return 'big-endian';
  if (normalized === 'le' || normalized === 'little' || normalized === 'littleendian') return 'little-endian';
  return value === undefined ? null : value;
}

function normalizeFPortPolicy(value) {
  if (!value || typeof value !== 'object') return null;
  const mode = value.mode === 'fixed' || value.mode === 'agnostic' ? value.mode : null;
  const ports = [...new Set((Array.isArray(value.ports) ? value.ports : [])
    .map(Number)
    .filter(port => Number.isInteger(port) && port >= 0 && port <= 255))].sort((a, b) => a - b);
  const representative = Number(value.representativeFPort);
  return {
    mode,
    ports,
    representativeFPort: Number.isInteger(representative) && representative >= 1 && representative <= 223
      ? representative
      : null,
    citation: String(value.citation || '').trim()
  };
}

function normalizeUplinkAssignments(value) {
  return (Array.isArray(value) ? value : []).map(assignment => ({
    exampleIndex: Number.isInteger(Number(assignment && assignment.exampleIndex))
      ? Number(assignment.exampleIndex)
      : null,
    input: normalizeHex(assignment && assignment.input),
    fPort: Number.isInteger(Number(assignment && assignment.fPort))
      ? Number(assignment.fPort)
      : null,
    citation: String(assignment && assignment.citation || '').trim()
  }));
}

function normalizeEvidence(value = {}) {
  return {
    messageTypes: Array.isArray(value.messageTypes) ? value.messageTypes.map(message => ({
      ...message,
      fPorts: Array.isArray(message && message.fPorts)
        ? message.fPorts.map(port => Number.isInteger(Number(port)) ? Number(port) : port)
        : [],
      fields: Array.isArray(message && message.fields) ? message.fields.map(field => ({
        ...field,
        endianness: canonicalEndianness(field && field.endianness),
        unit: canonicalEvidenceUnit(field && field.unit)
      })) : []
    })) : [],
    requestedMappings: Array.isArray(value.requestedMappings) ? value.requestedMappings.map(mapping => ({
      ...mapping,
      type: normalizeObjectType(mapping && mapping.type) || (mapping && mapping.type) || null,
      units: canonicalEvidenceUnit(mapping && mapping.units)
    })) : [],
    fPortPolicy: normalizeFPortPolicy(value.fPortPolicy),
    uplinkAssignments: normalizeUplinkAssignments(value.uplinkAssignments),
    knownAnswers: Array.isArray(value.knownAnswers) ? value.knownAnswers : [],
    conflicts: Array.isArray(value.conflicts) ? value.conflicts : [],
    ambiguities: Array.isArray(value.ambiguities) ? value.ambiguities : [],
    unsupported: Array.isArray(value.unsupported) ? value.unsupported : []
  };
}

function assignmentForExample(assignments, example, index) {
  const byIndex = assignments.find(assignment => assignment.exampleIndex === index + 1);
  if (byIndex) return byIndex;
  const byPayload = assignments.filter(assignment => assignment.input && assignment.input === example.hex);
  return byPayload.length === 1 ? byPayload[0] : null;
}

function validateEvidence(evidence, intake, options = {}) {
  const ambiguities = options.includeReported === false ? [] : [...(evidence.ambiguities || [])];
  const examples = intake.uplinkExamples || [];
  const missingFPort = examples.some(example => !Number.isInteger(example.fPort));
  const fPortPolicy = evidence.fPortPolicy;
  const portAgnostic = fPortPolicy && fPortPolicy.mode === 'agnostic';
  if (fPortPolicy) {
    if (!fPortPolicy.mode) ambiguities.push('fPort policy mode must be fixed or agnostic');
    if (!fPortPolicy.citation) ambiguities.push('fPort policy must include a citation');
    if (fPortPolicy.mode === 'fixed' && fPortPolicy.ports.length === 0) {
      ambiguities.push('Fixed fPort policy must identify at least one valid port');
    }
    if (fPortPolicy.mode === 'agnostic' && examples.some(example => Number.isInteger(example.fPort) && (example.fPort < 1 || example.fPort > 223))) {
      ambiguities.push('Port-agnostic application payloads must use fPorts from 1 through 223');
    }
  }
  if (missingFPort) {
    if (!fPortPolicy || !fPortPolicy.mode || !fPortPolicy.citation) {
      ambiguities.push('Missing fPort was not resolved to a cited fixed or port-agnostic policy');
    } else if (fPortPolicy.mode === 'fixed') {
      for (const [index, example] of examples.entries()) {
        if (Number.isInteger(example.fPort)) {
          if (!fPortPolicy.ports.includes(example.fPort)) {
            ambiguities.push(`Fixed fPort policy does not include supplied fPort ${example.fPort}`);
          }
          continue;
        }
        const assignment = assignmentForExample(evidence.uplinkAssignments || [], example, index);
        if (fPortPolicy.ports.length !== 1 && (!assignment || !fPortPolicy.ports.includes(assignment.fPort) || !assignment.citation)) {
          ambiguities.push(`Uplink example ${index + 1} is missing a cited assignment to one of the fixed fPorts`);
        }
      }
    }
  }
  if (intake.bacnetMappingStatus === 'deferred') {
    const mappingCheck = normalizeMappingEntries(evidence.requestedMappings);
    if (!mappingCheck.valid) {
      ambiguities.push(...(mappingCheck.errors.length > 0
        ? mappingCheck.errors
        : ['No BACnet mappings could be extracted from the cited official-document pages']));
    }
  }
  if (!Array.isArray(evidence.messageTypes) || evidence.messageTypes.length === 0) {
    ambiguities.push('No supported uplink message type could be extracted');
  }
  for (const message of evidence.messageTypes || []) {
    if (!message.name) ambiguities.push('A message type is missing its name');
    if (!portAgnostic && (!Array.isArray(message.fPorts) || message.fPorts.length === 0 || message.fPorts.some(port => port === null || port === '' || !Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 255))) {
      ambiguities.push(`Message '${message.name || 'unknown'}' is missing an explicit fPort`);
    }
    if (fPortPolicy && fPortPolicy.mode === 'fixed' && (message.fPorts || []).some(port => !fPortPolicy.ports.includes(Number(port)))) {
      ambiguities.push(`Message '${message.name || 'unknown'}' uses an fPort outside the fixed policy`);
    }
    if (!Number.isInteger(Number(message.minimumLength)) || Number(message.minimumLength) < 1) {
      ambiguities.push(`Message '${message.name || 'unknown'}' is missing a positive minimum payload length`);
    }
    if (!Array.isArray(message.fields) || message.fields.length === 0) {
      ambiguities.push(`Message '${message.name || 'unknown'}' has no evidenced fields`);
    }
    for (const field of message.fields || []) {
      if (!field.name || field.offset === null || field.offset === '' || !Number.isInteger(Number(field.offset)) || Number(field.offset) < 0 || field.length === null || field.length === '' || !Number.isInteger(Number(field.length)) || Number(field.length) < 1 || !field.citation) {
        ambiguities.push(`Message '${message.name || 'unknown'}' contains a field without name, byte offset, byte length, or citation`);
      }
    }
  }
  for (const answer of evidence.knownAnswers || []) {
    const normalizedInput = normalizeHex(answer.input);
    const validAnswerPort = portAgnostic && (answer.fPort === null || answer.fPort === '' || answer.fPort === undefined)
      ? true
      : (answer.fPort !== null && answer.fPort !== '' && Number.isInteger(Number(answer.fPort)) && Number(answer.fPort) >= 0 && Number(answer.fPort) <= 255);
    if (!validAnswerPort || normalizedInput.length < 2 || normalizedInput.length % 2 !== 0 || !answer.expectedOutput || typeof answer.expectedOutput !== 'object' || !answer.citation) {
      ambiguities.push('A known-answer example is missing a valid fPort, payload, decoded output, or citation');
    }
  }
  const evidencedPorts = new Set((evidence.messageTypes || []).flatMap(message => message.fPorts || []).map(Number));
  for (const [index, example] of examples.entries()) {
    if (Number.isInteger(example.fPort) && !portAgnostic && !evidencedPorts.has(example.fPort)) {
      ambiguities.push(`No evidenced message type covers supplied fPort ${example.fPort}`);
    } else if (!Number.isInteger(example.fPort) && fPortPolicy && fPortPolicy.mode === 'fixed') {
      const assignment = assignmentForExample(evidence.uplinkAssignments || [], example, index);
      const resolvedPort = fPortPolicy.ports.length === 1 ? fPortPolicy.ports[0] : (assignment && assignment.fPort);
      if (Number.isInteger(resolvedPort) && !evidencedPorts.has(resolvedPort)) {
        ambiguities.push(`No evidenced message type covers resolved fPort ${resolvedPort} for uplink example ${index + 1}`);
      }
    }
  }
  return [...new Set(ambiguities.map(item => typeof item === 'string' ? item : JSON.stringify(item)))];
}

function findingMessage(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.message === 'string') return value.message;
  if (value && typeof value.detail === 'string') return value.detail;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function equivalentUnitDifference(message) {
  const tokens = String(message || '').match(/[A-Za-z%°µμ][A-Za-z0-9%°µμ/_-]*/g) || [];
  const normalized = tokens.map(normalizeUnit).filter(Boolean);
  return normalized.length >= 2 && new Set(normalized).size === 1;
}

function normalizeFieldName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function requestedMappingNames(context = {}) {
  const entries = [
    ...((context.intake && context.intake.requestedMappings) || []),
    ...((context.evidence && context.evidence.requestedMappings) || [])
  ];
  return new Set(entries.map(entry => normalizeFieldName(entry && entry.name)).filter(Boolean));
}

function unitSubject(message) {
  const match = String(message || '').match(
    /\bunits?\s+(?:for|of)\s+[`'"]?(.+?)[`'"]?(?=\s*\(|\s+(?:is|are|was|were|has|have|cannot|could|remains?|not)\b|[,;:.]|$)/i
  );
  return match ? normalizeFieldName(match[1]) : null;
}

function classifyEvidenceFinding(value, kind = 'conflict', context = {}) {
  const message = findingMessage(value);
  const suppliedCategory = value && typeof value === 'object' ? value.category : null;
  const suppliedSeverity = value && typeof value === 'object' ? value.severity : null;
  const equivalentUnit = equivalentUnitDifference(message);
  const formatOnly = equivalentUnit || /\b(?:format(?:ting)?|capitalization|case|spelling|punctuation|whitespace|wording|label|naming|ordering|alias|equivalent)\b/i.test(message);
  const valueConflict = /\b(?:versus|vs\.?|mismatch|disagree(?:ment)?|conflict|different\s+values?)\b/i.test(message);
  const numericValues = String(message).match(/-?\d+(?:\.\d+)?/g) || [];
  const differentNumericValues = new Set(numericValues).size > 1;
  const missingCitation = /\b(?:missing|absent|without|no)\b.{0,24}\bcitation\b|\bcitation\b.{0,24}\b(?:missing|absent)\b/i.test(message);
  const criticalProtocol = /\b(?:f\s*port|message\s*(?:type|selector)|selector|offset|byte\s*(?:offset|length|order)|minimum\s*length|endianness|signedness|signed|scale|formula|bit\s*(?:layout|position|mask)?|checksum|crc|object\s*type|bacnet\s*type|units?)\b/i.test(message);
  const missingKnownAnswer = /\b(?:no|missing|absent|without)\b.{0,80}\bknown[- ]?answers?\b|\bknown[- ]?answers?\b.{0,80}\b(?:cannot|could not|not|missing|absent|unavailable)\b/i.test(message);
  const subject = unitSubject(message);
  const mappings = requestedMappingNames(context);
  const unrequestedUnit = Boolean(subject && mappings.size > 0 && !mappings.has(subject));
  const authoritativeDecoder = context.intake && context.intake.decoderAuthority === 'user-provided';
  const decoderOnlyEvidence = /\b(?:only|solely)\s+evidenced\s+by\s+(?:the\s+)?(?:official\s+|vendor[- ]published\s+)?decoder\b|\bdecoder\b.{0,40}\b(?:only|sole)\s+(?:evidence|source)\b/i.test(message);
  const explicitContradiction = valueConflict || /\b(?:contradict(?:ion|s|ory)?|inconsisten(?:t|cy))\b/i.test(message);

  let category = ['protocol', 'mapping', 'format', 'citation'].includes(suppliedCategory)
    ? suppliedCategory
    : (/\b(?:bacnet|object\s*type|requested\s*mapping)\b/i.test(message)
        ? 'mapping'
        : (/\bcitation|source\s*(?:wording|reference)|page\s*reference\b/i.test(message)
            ? 'citation'
            : (formatOnly ? 'format' : 'protocol')));
  let severity = suppliedSeverity === 'warning' || suppliedSeverity === 'blocking'
    ? suppliedSeverity
    : 'blocking';

  if (missingKnownAnswer) {
    category = 'citation';
    severity = 'warning';
  } else if (unrequestedUnit && !explicitContradiction) {
    category = 'protocol';
    severity = 'warning';
  } else if (authoritativeDecoder && decoderOnlyEvidence && !explicitContradiction) {
    category = 'citation';
    severity = 'warning';
  } else if (missingCitation) {
    category = 'citation';
    severity = 'blocking';
  } else if (criticalProtocol && differentNumericValues && !equivalentUnit) {
    severity = 'blocking';
  } else if (criticalProtocol && valueConflict && !formatOnly && !equivalentUnit) {
    severity = 'blocking';
  } else if (equivalentUnit || formatOnly) {
    category = 'format';
    severity = 'warning';
  } else if (criticalProtocol || category === 'protocol' || category === 'mapping') {
    severity = 'blocking';
  } else if (category === 'format' || category === 'citation') {
    severity = 'warning';
  }

  return { severity, category, message, kind };
}

function validationFinding(message) {
  return {
    severity: 'blocking',
    category: /bacnet|mapping/i.test(message) ? 'mapping' : 'protocol',
    message,
    kind: 'ambiguity'
  };
}

function uniqueFindings(findings) {
  const seen = new Set();
  return findings.filter(finding => {
    const key = `${finding.severity}\n${finding.category}\n${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidenceDecision(consolidated, extractions, findings) {
  const normalizedFindings = uniqueFindings(findings);
  const blocking = normalizedFindings.filter(finding => finding.severity === 'blocking');
  const warnings = normalizedFindings.filter(finding => finding.severity === 'warning');
  const warningMessages = new Set(warnings.map(finding => finding.message));
  const resolvedConsolidated = consolidated ? {
    ...consolidated,
    conflicts: (consolidated.conflicts || []).filter(item => !warningMessages.has(findingMessage(item))),
    ambiguities: (consolidated.ambiguities || []).filter(item => !warningMessages.has(findingMessage(item)))
  } : null;
  return {
    approved: Boolean(resolvedConsolidated) && blocking.length === 0,
    conflicts: blocking.filter(finding => finding.kind === 'conflict').map(finding => finding.message),
    ambiguities: blocking.filter(finding => finding.kind !== 'conflict').map(finding => finding.message),
    warnings,
    findings: normalizedFindings,
    consolidated: resolvedConsolidated,
    extractions
  };
}

async function extractEvidence(model, intake, source, operation = 'evidence-extraction') {
  const startedAt = Date.now();
  logProgress('evidence', 'extraction started', { operation, model: model.label });
  const value = await completeJson(model, [
    { role: 'system', content: loadPrompt('extract-evidence') },
    { role: 'user', content: JSON.stringify(evidencePayload(intake, source)) }
  ], { maxTokens: 8000, operation });
  const evidence = normalizeEvidence(value);
  logProgress('evidence', 'extraction completed', {
    operation,
    model: model.label,
    elapsedSeconds: elapsedSeconds(startedAt),
    messageTypes: evidence.messageTypes.length,
    knownAnswers: evidence.knownAnswers.length,
    conflicts: evidence.conflicts.length,
    ambiguities: evidence.ambiguities.length
  });
  return evidence;
}

async function buildEvidence(models, intake, source) {
  const primary = await extractEvidence(models.primary, intake, source, 'primary-evidence-extraction');
  const primaryAmbiguities = validateEvidence(primary, intake, { includeReported: false });
  logProgress('evidence', 'primary evidence validated', {
    model: models.primary.label,
    validationAmbiguities: primaryAmbiguities.length,
    conflicts: primary.conflicts.length
  });
  if (!models.secondary) {
    const classificationContext = { intake, evidence: primary };
    const findings = [
      ...primary.conflicts.map(item => classifyEvidenceFinding(item, 'conflict', classificationContext)),
      ...primary.ambiguities.map(item => classifyEvidenceFinding(item, 'ambiguity', classificationContext)),
      ...primaryAmbiguities.map(validationFinding)
    ];
    return evidenceDecision(primary, [primary], findings);
  }

  const secondary = await extractEvidence(models.secondary, intake, source, 'secondary-evidence-extraction');
  const secondaryAmbiguities = validateEvidence(secondary, intake, { includeReported: false });
  logProgress('evidence', 'reconciliation started', {
    primaryModel: models.primary.label,
    secondaryModel: models.secondary.label,
    primaryValidationAmbiguities: primaryAmbiguities.length,
    secondaryValidationAmbiguities: secondaryAmbiguities.length
  });
  const reconciliation = await completeJson(models.primary, [
    { role: 'system', content: loadPrompt('reconcile-evidence') },
    { role: 'user', content: JSON.stringify({ source: evidencePayload(intake, source), primary, secondary }) }
  ], { maxTokens: 6000, operation: 'evidence-reconciliation' });
  const consolidated = reconciliation.consolidated ? normalizeEvidence(reconciliation.consolidated) : null;
  const consolidatedAmbiguities = consolidated
    ? validateEvidence(consolidated, intake, { includeReported: false })
    : ['Evidence reconciliation did not return a consolidated protocol'];
  const reconciliationFindings = Array.isArray(reconciliation.findings) ? reconciliation.findings : [];
  const reconciliationConflicts = Array.isArray(reconciliation.conflicts) ? reconciliation.conflicts : [];
  const reconciliationAmbiguities = Array.isArray(reconciliation.ambiguities) ? reconciliation.ambiguities : [];
  const classificationContext = { intake, evidence: consolidated || primary };
  const findings = [
    ...reconciliationFindings.map(item => classifyEvidenceFinding(item, item && item.kind ? item.kind : 'conflict', classificationContext)),
    ...reconciliationConflicts.map(item => classifyEvidenceFinding(item, 'conflict', classificationContext)),
    ...reconciliationAmbiguities.map(item => classifyEvidenceFinding(item, 'ambiguity', classificationContext)),
    ...((consolidated && consolidated.conflicts) || []).map(item => classifyEvidenceFinding(item, 'conflict', classificationContext)),
    ...((consolidated && consolidated.ambiguities) || []).map(item => classifyEvidenceFinding(item, 'ambiguity', classificationContext)),
    ...consolidatedAmbiguities.map(validationFinding)
  ];
  const reportedFindings = reconciliationFindings.length + reconciliationConflicts.length + reconciliationAmbiguities.length;
  if (reconciliation.approved !== true && reportedFindings === 0) {
    findings.push({
      severity: 'blocking',
      category: 'protocol',
      message: 'Evidence reconciler rejected the evidence without an explainable warning-level difference',
      kind: 'ambiguity'
    });
  }
  const decision = evidenceDecision(consolidated, [primary, secondary], findings);
  logProgress('evidence', 'reconciliation completed', {
    approved: decision.approved,
    reconcilerApproved: reconciliation.approved === true,
    conflicts: decision.conflicts.length,
    ambiguities: decision.ambiguities.length,
    warnings: decision.warnings.length
  });
  return decision;
}

module.exports = {
  evidencePayload,
  extractEvidence,
  buildEvidence,
  validateEvidence,
  normalizeEvidence,
  normalizeFPortPolicy,
  classifyEvidenceFinding
};
