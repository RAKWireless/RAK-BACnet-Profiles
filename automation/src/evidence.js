'use strict';

const { completeJson } = require('./model-client');
const { loadPrompt } = require('./prompt-loader');
const { normalizeHex } = require('./issue-parser');

function evidencePayload(intake, source) {
  return {
    issue: {
      vendor: intake.vendor,
      model: intake.model,
      lorawanClass: intake.lorawanClass,
      lorawanVersion: intake.lorawanVersion,
      uplinkExamples: intake.uplinkExamples,
      uplinkDescription: intake.uplinkText,
      providedDecoder: intake.decoder,
      bacnetMapping: intake.bacnetMapping
    },
    officialDocument: {
      url: source.url,
      type: source.type,
      pages: source.pages,
      text: source.text
    }
  };
}

function normalizeEvidence(value) {
  return {
    messageTypes: Array.isArray(value.messageTypes) ? value.messageTypes : [],
    knownAnswers: Array.isArray(value.knownAnswers) ? value.knownAnswers : [],
    conflicts: Array.isArray(value.conflicts) ? value.conflicts : [],
    ambiguities: Array.isArray(value.ambiguities) ? value.ambiguities : [],
    unsupported: Array.isArray(value.unsupported) ? value.unsupported : []
  };
}

function validateEvidence(evidence, intake) {
  const ambiguities = [...(evidence.ambiguities || [])];
  if (!Array.isArray(evidence.messageTypes) || evidence.messageTypes.length === 0) {
    ambiguities.push('No supported uplink message type could be extracted');
  }
  for (const message of evidence.messageTypes || []) {
    if (!message.name) ambiguities.push('A message type is missing its name');
    if (!Array.isArray(message.fPorts) || message.fPorts.length === 0 || message.fPorts.some(port => port === null || port === '' || !Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 255)) {
      ambiguities.push(`Message '${message.name || 'unknown'}' is missing an explicit fPort`);
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
    if (answer.fPort === null || answer.fPort === '' || !Number.isInteger(Number(answer.fPort)) || Number(answer.fPort) < 0 || Number(answer.fPort) > 255 || normalizedInput.length < 2 || normalizedInput.length % 2 !== 0 || !answer.expectedOutput || typeof answer.expectedOutput !== 'object' || !answer.citation) {
      ambiguities.push('A known-answer example is missing a valid fPort, payload, decoded output, or citation');
    }
  }
  const evidencedPorts = new Set((evidence.messageTypes || []).flatMap(message => message.fPorts || []).map(Number));
  for (const example of intake.uplinkExamples || []) {
    if (!evidencedPorts.has(Number(example.fPort))) ambiguities.push(`No evidenced message type covers supplied fPort ${example.fPort}`);
  }
  return [...new Set(ambiguities.map(item => typeof item === 'string' ? item : JSON.stringify(item)))];
}

async function extractEvidence(model, intake, source) {
  const value = await completeJson(model, [
    { role: 'system', content: loadPrompt('extract-evidence') },
    { role: 'user', content: JSON.stringify(evidencePayload(intake, source)) }
  ], { maxTokens: 8000 });
  return normalizeEvidence(value);
}

async function buildEvidence(models, intake, source) {
  const primary = await extractEvidence(models.primary, intake, source);
  const primaryAmbiguities = validateEvidence(primary, intake);
  if (primary.conflicts.length > 0 || primaryAmbiguities.length > 0) {
    return { approved: false, conflicts: primary.conflicts, ambiguities: primaryAmbiguities, consolidated: primary, extractions: [primary] };
  }
  if (!models.secondary) {
    return { approved: true, conflicts: [], ambiguities: [], consolidated: primary, extractions: [primary] };
  }

  const secondary = await extractEvidence(models.secondary, intake, source);
  const reconciliation = await completeJson(models.primary, [
    { role: 'system', content: loadPrompt('reconcile-evidence') },
    { role: 'user', content: JSON.stringify({ source: evidencePayload(intake, source), primary, secondary }) }
  ], { maxTokens: 6000 });
  const consolidated = reconciliation.consolidated ? normalizeEvidence(reconciliation.consolidated) : null;
  const consolidatedAmbiguities = consolidated ? validateEvidence(consolidated, intake) : ['Evidence reconciliation did not return a consolidated protocol'];
  const conflicts = [
    ...(Array.isArray(reconciliation.conflicts) ? reconciliation.conflicts : []),
    ...((consolidated && consolidated.conflicts) || [])
  ];
  const ambiguities = [
    ...(Array.isArray(reconciliation.ambiguities) ? reconciliation.ambiguities : []),
    ...consolidatedAmbiguities
  ];
  return {
    approved: reconciliation.approved === true && conflicts.length === 0 && ambiguities.length === 0,
    conflicts,
    ambiguities,
    consolidated,
    extractions: [primary, secondary]
  };
}

module.exports = { evidencePayload, extractEvidence, buildEvidence, validateEvidence };
