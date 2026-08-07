'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { completeJson } = require('./model-client');
const { loadPrompt } = require('./prompt-loader');
const { buildEvidence, normalizeFPortPolicy } = require('./evidence');
const { selectReference, loadRepositoryExample } = require('./reference-selector');
const { normalizeHex } = require('./issue-parser');
const { writeJson, writeText } = require('./io');
const { compileCodec } = require('../../scripts/lib/codec-sandbox');
const { logProgress, elapsedSeconds } = require('./progress');
const {
  analyzeRequestedMappings,
  normalizeMappingEntries,
  formatRequestedMappings
} = require('../../scripts/lib/validation/requested-mapping');

const REQUIRED_CODEC_FUNCTIONS = ['Decode', 'decodeUplink'];

function outputPaths(outputDir, intake) {
  const relativeProfile = path.join('profiles', intake.vendor, `${intake.profileName}.yaml`);
  const relativeFixture = path.join('profiles', intake.vendor, 'tests', `${intake.profileName}.test.json`);
  return {
    profile: path.join(outputDir, relativeProfile),
    fixture: path.join(outputDir, relativeFixture),
    relativeProfile,
    relativeFixture,
    context: path.join(outputDir, 'context.json'),
    manifest: path.join(outputDir, 'manifest.json'),
    review: path.join(outputDir, 'review.md')
  };
}

function profileIdentity(intake, previousProfile) {
  return {
    model: intake.profileName,
    profileVersion: '1.0.0',
    name: intake.model,
    vendor: intake.vendor,
    id: previousProfile && previousProfile.id ? previousProfile.id : crypto.randomUUID()
  };
}

function normalizeCodecSource(value) {
  let source = String(value || '').trim();
  source = source
    .replace(/^```(?:javascript|js)?\s*(?:\r?\n)?/i, '')
    .replace(/(?:\r?\n)?```\s*$/i, '')
    .trim();
  source = source
    .replace(/^(?:javascript|js)\s+(?=function\b)/i, '')
    .trim();
  return source;
}

function validateCodecPreflight(codec) {
  const errors = [];
  if (!codec) errors.push('codec is empty');
  if (/```/.test(codec)) errors.push('codec contains a Markdown code fence');
  if (/function\s+(?:Encode|encodeDownlink)\b|\b(?:Encode|encodeDownlink)\s*=/.test(codec)) {
    errors.push('codec must be uplink-only and must not declare Encode or encodeDownlink');
  }
  for (const functionName of REQUIRED_CODEC_FUNCTIONS) {
    const declaration = new RegExp(`\\bfunction\\s+${functionName}\\s*\\(`);
    if (!declaration.test(codec)) errors.push(`codec must declare function ${functionName}`);
  }
  if (errors.length === 0) {
    try {
      compileCodec(codec);
    } catch (error) {
      errors.push(`codec does not compile: ${error.message}`);
    }
  }
  return { valid: errors.length === 0, errors, requiredFunctions: REQUIRED_CODEC_FUNCTIONS };
}

function candidatePreflight(profileYaml) {
  const profile = yaml.load(profileYaml);
  const codec = validateCodecPreflight(profile && profile.codec);
  return {
    valid: codec.valid,
    checks: {
      codec,
      rootKeys: profile && typeof profile === 'object' ? Object.keys(profile) : [],
      datatypeChannels: profile && profile.datatype ? Object.keys(profile.datatype).length : 0
    }
  };
}

async function runStage(stage, operation, operationName = stage) {
  const startedAt = Date.now();
  logProgress(stage, 'stage started', { operation: operationName });
  try {
    const result = await operation();
    logProgress(stage, 'stage completed', {
      operation: operationName,
      elapsedSeconds: elapsedSeconds(startedAt)
    });
    return result;
  } catch (error) {
    logProgress(stage, 'stage failed', {
      operation: operationName,
      elapsedSeconds: elapsedSeconds(startedAt),
      errorType: error && error.name,
      errorCode: error && error.code
    });
    if (!error.stage) error.stage = stage;
    throw error;
  }
}

function normalizeProfileYaml(rawYaml, intake, previousProfile = null) {
  const parsed = yaml.load(String(rawYaml || ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Generated profileYaml must contain one YAML object');
  if (typeof parsed.codec !== 'string') throw new Error('Generated profileYaml is missing a codec string');
  if (!parsed.datatype || typeof parsed.datatype !== 'object') throw new Error('Generated profileYaml is missing datatype mappings');

  const codec = normalizeCodecSource(parsed.codec);
  const codecPreflight = validateCodecPreflight(codec);
  if (!codecPreflight.valid) {
    const error = new Error(`Generated codec preflight failed: ${codecPreflight.errors.join('; ')}`);
    error.code = 'INVALID_GENERATED_CODEC';
    throw error;
  }

  const lorawan = {
    adrAlgorithm: 'LoRa Only',
    classCDownlinkTimeout: 5,
    regionalParametersRevision: 'A',
    supportOTAA: true,
    ...(parsed.lorawan || {}),
    macVersion: intake.lorawanVersion,
    supportClassB: /Class B/i.test(intake.lorawanClass),
    supportClassC: /Class C/i.test(intake.lorawanClass)
  };
  const ordered = {
    codec,
    datatype: parsed.datatype,
    lorawan,
    ...profileIdentity(intake, previousProfile)
  };
  return yaml.dump(ordered, { noRefs: true, lineWidth: -1, sortKeys: false, quotingType: '"' });
}

function normalizedKnownAnswers(evidence, intake) {
  const representativeFPort = intake.fPortPolicy && intake.fPortPolicy.mode === 'agnostic'
    ? intake.fPortPolicy.representativeFPort
    : null;
  return (evidence.knownAnswers || []).map(answer => ({
    ...answer,
    normalizedInput: normalizeHex(answer.input),
    fPort: (answer.fPort === null || answer.fPort === '' || answer.fPort === undefined) && representativeFPort
      ? representativeFPort
      : Number(answer.fPort)
  }));
}

function normalizeFixture(rawFixture, intake, evidence, reviewMode, source = null) {
  const supplied = Array.isArray(rawFixture && rawFixture.testCases) ? rawFixture.testCases : [];
  const fixtureFPortPolicy = intake.fPortPolicy || {
    mode: 'fixed',
    ports: [...new Set((intake.uplinkExamples || []).map(example => example.fPort).filter(Number.isInteger))].sort((a, b) => a - b),
    citation: 'Explicit fPort values supplied in the Issue'
  };
  const knownAnswers = normalizedKnownAnswers(evidence, intake);
  const applicableKnownAnswers = knownAnswers.filter(answer => intake.uplinkExamples.some(
    example => example.hex === answer.normalizedInput && example.fPort === answer.fPort
  ));
  const testCases = intake.uplinkExamples.map((example, index) => {
    const generated = supplied.find(item => normalizeHex(item.input) === example.hex && Number(item.fPort) === example.fPort) || {};
    const known = applicableKnownAnswers.find(item => item.normalizedInput === example.hex && item.fPort === example.fPort);
    const testCase = {
      name: /^[\x20-\x7E]+$/.test(generated.name || '') ? generated.name : `Uplink example ${index + 1}`,
      fPort: example.fPort,
      input: example.hex,
      description: generated.description || example.sourceLine || `Payload supplied in Issue #${intake.issueNumber}`
    };
    if (generated.messageType) testCase.messageType = generated.messageType;
    if (known && Object.prototype.hasOwnProperty.call(generated, 'expectedOutput')) {
      testCase.expectedOutput = generated.expectedOutput;
    }
    return testCase;
  });

  const sources = [
    { type: 'issue', reference: intake.issueUrl || `Issue #${intake.issueNumber}`, citation: 'Uplink examples and requested BACnet mapping' }
  ];
  if (source && source.type !== 'decoder') {
    sources.push({
      type: 'official-document',
      reference: source.url || intake.datasheetUrl,
      citation: source.sha256 ? `Protocol documentation SHA-256: ${source.sha256}` : 'Protocol documentation used during generation'
    });
  }
  if (intake.decoderSource) {
    const userProvidedDecoder = intake.decoderAuthority === 'user-provided';
    sources.push({
      type: 'customer-data',
      reference: intake.decoderUrl || intake.issueUrl || `Issue #${intake.issueNumber}`,
      citation: `${userProvidedDecoder ? 'User-provided authoritative protocol decoder' : 'Automatically discovered supporting decoder'}; text retained as non-executable data (${intake.decoderOrigin || 'unknown origin'}${intake.decoderSha256 ? `; SHA-256: ${intake.decoderSha256}` : ''})`
    });
  }

  return {
    schemaVersion: 1,
    profile: intake.profileName,
    evidenceLevel: applicableKnownAnswers.length > 0 ? 'known-answer' : 'documentation-only',
    reviewMode,
    fPortPolicy: fixtureFPortPolicy,
    sources,
    robustness: { checkTruncation: true, checkUnknownFPort: true },
    testCases
  };
}

function fPortAssignment(evidence, example, index) {
  const assignments = evidence.uplinkAssignments || [];
  const byIndex = assignments.find(assignment => assignment.exampleIndex === index + 1);
  if (byIndex) return byIndex;
  const byPayload = assignments.filter(assignment => assignment.input === example.hex);
  return byPayload.length === 1 ? byPayload[0] : null;
}

function fPortResolutionError(message) {
  const error = new Error(message);
  error.code = 'FPORT_UNRESOLVED';
  error.stage = 'evidence';
  return error;
}

function resolveIntakeFPorts(intake, evidence) {
  const examples = intake.uplinkExamples || [];
  const missingFPort = examples.some(example => !Number.isInteger(example.fPort));
  const evidencedPolicy = normalizeFPortPolicy(evidence && evidence.fPortPolicy);
  let policy = evidencedPolicy;

  if (!policy || !policy.mode) {
    if (missingFPort) throw fPortResolutionError('Missing fPort could not be resolved from official documentation or decoder evidence');
    policy = {
      mode: 'fixed',
      ports: [...new Set(examples.map(example => example.fPort))].sort((a, b) => a - b),
      representativeFPort: null,
      citation: 'Explicit fPort values supplied in the Issue'
    };
  }

  if (!policy.citation) throw fPortResolutionError('Resolved fPort policy is missing a citation');
  if (policy.mode === 'fixed' && policy.ports.length === 0) {
    throw fPortResolutionError('Fixed fPort policy does not identify any ports');
  }

  let representativeFPort = policy.representativeFPort;
  if (policy.mode === 'agnostic' && !representativeFPort) {
    representativeFPort = examples.find(example => Number.isInteger(example.fPort) && example.fPort >= 1 && example.fPort <= 223)?.fPort || 1;
  }

  const resolvedExamples = examples.map((example, index) => {
    if (Number.isInteger(example.fPort)) {
      if (policy.mode === 'fixed' && !policy.ports.includes(example.fPort)) {
        throw fPortResolutionError(`Fixed fPort policy does not include supplied fPort ${example.fPort}`);
      }
      if (policy.mode === 'agnostic' && (example.fPort < 1 || example.fPort > 223)) {
        throw fPortResolutionError(`Port-agnostic application payload cannot use reserved fPort ${example.fPort}`);
      }
      return example;
    }
    if (policy.mode === 'agnostic') {
      return { ...example, fPort: representativeFPort, inferredFPort: true };
    }
    if (policy.ports.length === 1) {
      return { ...example, fPort: policy.ports[0], inferredFPort: true };
    }
    const assignment = fPortAssignment(evidence, example, index);
    if (!assignment || !policy.ports.includes(assignment.fPort) || !assignment.citation) {
      throw fPortResolutionError(`Uplink example ${index + 1} could not be assigned to one of the evidenced fixed fPorts`);
    }
    return { ...example, fPort: assignment.fPort, inferredFPort: true, fPortCitation: assignment.citation };
  });

  return {
    ...intake,
    fPortStatus: 'resolved',
    fPortPolicy: policy.mode === 'agnostic'
      ? { mode: 'agnostic', representativeFPort, citation: policy.citation }
      : { mode: 'fixed', ports: policy.ports, citation: policy.citation },
    uplinkExamples: resolvedExamples
  };
}

function generationUserContent(context) {
  return JSON.stringify({
    issue: context.intake,
    officialDocument: { ...context.source, text: context.source.text },
    evidence: context.evidence,
    mappingReference: context.reference,
    repositoryExample: context.repositoryExample,
    authorizedMaintainerFeedback: context.feedback || ''
  });
}

function resolveIntakeMapping(intake, evidence) {
  const request = analyzeRequestedMappings(intake.bacnetMapping);
  let mappings;
  if ((intake.bacnetMappingStatus || request.status) === 'deferred') {
    const extracted = normalizeMappingEntries(evidence && evidence.requestedMappings);
    if (!extracted.valid) {
      const error = new Error(extracted.errors.join('; ') || 'No BACnet mappings were extracted from the cited official-document pages');
      error.code = 'BACNET_MAPPING_UNRESOLVED';
      error.stage = 'evidence';
      throw error;
    }
    mappings = extracted.mappings;
  } else {
    mappings = request.mappings;
  }
  if (!mappings || mappings.length === 0) {
    const error = new Error('No resolved BACnet mappings are available for profile generation');
    error.code = 'BACNET_MAPPING_UNRESOLVED';
    error.stage = 'evidence';
    throw error;
  }
  const original = intake.bacnetMapping;
  return {
    ...intake,
    bacnetMapping: formatRequestedMappings(mappings),
    bacnetMappingOriginal: original,
    bacnetMappingSource: intake.bacnetMappingStatus || request.status,
    bacnetMappingStatus: 'resolved',
    requestedMappings: mappings
  };
}

async function generateRawCandidate(model, context) {
  return completeJson(model, [
    { role: 'system', content: loadPrompt('generate-profile') },
    { role: 'user', content: generationUserContent(context) }
  ], { maxTokens: 12000, operation: 'profile-generation' });
}

async function repairRawCandidate(model, context, previous, validationReport, feedback) {
  return completeJson(model, [
    { role: 'system', content: loadPrompt('repair-profile') },
    {
      role: 'user',
      content: JSON.stringify({
        evidence: context.evidence,
        issue: context.intake,
        officialDocument: context.source,
        mappingReference: context.reference,
        repositoryExample: context.repositoryExample || loadRepositoryExample(),
        previousProfileYaml: previous.profileYaml,
        previousFixture: previous.fixture,
        validationReport,
        authorizedMaintainerFeedback: feedback || ''
      })
    }
  ], { maxTokens: 12000, operation: 'profile-repair' });
}

function normalizeReview(value) {
  const severity = value && ['none', 'low', 'high'].includes(value.severity) ? value.severity : 'high';
  return {
    approved: Boolean(value && value.approved === true && severity !== 'high'),
    severity,
    findings: value && Array.isArray(value.findings) ? value.findings : ['Reviewer returned an invalid findings list'],
    fieldChecks: value && Array.isArray(value.fieldChecks) ? value.fieldChecks : [],
    attackCases: value && Array.isArray(value.attackCases) ? value.attackCases : []
  };
}

function markdownCell(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/@/g, '@\u200b');
}

function indentedCode(value) {
  return String(value || '').split(/\r?\n/).map(line => `    ${line}`).join('\n');
}

async function reviewCandidate(models, context, profileYaml, fixture) {
  const payload = JSON.stringify({
    issue: context.intake,
    officialDocument: context.source,
    evidence: context.evidence,
    profileYaml,
    fixture,
    machinePreflight: candidatePreflight(profileYaml)
  });
  const reviewerModel = models.secondary || models.primary;
  const review = normalizeReview(await completeJson(reviewerModel, [
    { role: 'system', content: loadPrompt('review-profile') },
    { role: 'user', content: payload }
  ], { maxTokens: 6000, operation: 'protocol-review' }));
  const adversarial = normalizeReview(await completeJson(models.primary, [
    { role: 'system', content: loadPrompt('adversarial-review') },
    { role: 'user', content: payload }
  ], { maxTokens: 6000, operation: 'adversarial-review' }));
  return { review, adversarial, approved: review.approved && adversarial.approved };
}

function evidenceFieldRows(evidence) {
  const rows = [];
  for (const message of evidence.messageTypes || []) {
    for (const field of message.fields || []) {
      const location = field.offsetFromEnd ? `end-${field.offsetFromEnd}` : field.offset;
      rows.push(`| ${markdownCell(message.name)} | ${markdownCell(field.name)} | ${markdownCell(location)} | ${markdownCell(field.length)} | ${markdownCell(field.endianness)} | ${markdownCell(field.formula ?? field.scale)} | ${markdownCell(field.citation || message.citation)} |`);
    }
    for (const structure of message.repeatedStructures || []) {
      for (const field of structure.fields || []) {
        const location = `${structure.startOffset} + n*${structure.stride} + ${field.offset}`;
        rows.push(`| ${markdownCell(`${message.name} / ${structure.name}[*]`)} | ${markdownCell(field.name)} | ${markdownCell(location)} | ${markdownCell(field.length)} | ${markdownCell(field.endianness)} | ${markdownCell(field.formula ?? field.scale)} | ${markdownCell(field.citation || structure.citation || message.citation)} |`);
      }
    }
  }
  return rows;
}

function buildReviewMarkdown(manifest, context, fixture) {
  const rows = evidenceFieldRows(context.evidence);
  const tests = fixture.testCases.map(testCase => `| ${testCase.name} | ${testCase.fPort} | ${testCase.input} | ${Object.prototype.hasOwnProperty.call(testCase, 'expectedOutput') ? 'Known answer' : 'Execution + documentation review'} |`);
  const findings = [...manifest.review.findings, ...manifest.adversarial.findings];
  const evidenceWarnings = context.evidenceWarnings || [];
  const sourceLines = [
    `- ${context.source.url} (${context.source.type}${context.source.pages ? `, ${context.source.pages} pages` : ''}${context.source.sha256 ? `; SHA-256: \`${context.source.sha256}\`` : ''})`,
    `- ${context.intake.issueUrl || `Issue #${context.intake.issueNumber}`}`
  ];
  if (context.intake.decoderSource && context.source.type !== 'decoder') {
    const decoderLabel = context.intake.decoderAuthority === 'user-provided'
      ? 'user-provided authoritative protocol decoder; non-executable input'
      : 'automatically discovered supporting decoder; non-executable input';
    sourceLines.push(`- ${context.intake.decoderUrl || `Issue #${context.intake.issueNumber} decoder`} (${decoderLabel}; ${context.intake.decoderOrigin || 'unknown origin'}${context.intake.decoderSha256 ? `; SHA-256: \`${context.intake.decoderSha256}\`` : ''})`);
  }
  return `## Automated Profile Evidence\n\n` +
    `- Issue: #${context.intake.issueNumber}\n` +
    `- Evidence level: **${manifest.evidenceLevel}**\n` +
    `- Model review: **${manifest.reviewMode}**\n` +
    `- Supported scope: **uplink only**\n` +
    `- Hardware verified: **no**\n\n` +
    `### Sources\n\n` +
    `${sourceLines.join('\n')}\n\n` +
    `### Protocol field checks\n\n` +
    `| Message | Field | Offset | Length | Endian | Formula | Citation |\n|---|---|---:|---:|---|---|---|\n` +
    `${rows.length > 0 ? rows.join('\n') : '| — | — | — | — | — | — | No structured rows returned |'}\n\n` +
    `### Resolved BACnet mapping\n\n${indentedCode(context.intake.bacnetMapping)}\n\n` +
    `${context.intake.bacnetMappingOriginal && context.intake.bacnetMappingOriginal !== context.intake.bacnetMapping ? `### Original mapping request\n\n${indentedCode(context.intake.bacnetMappingOriginal)}\n\n` : ''}` +
    `### fPort policy\n\n${indentedCode(JSON.stringify(context.intake.fPortPolicy, null, 2))}\n\n` +
    `### Test coverage\n\n| Test | fPort | Payload | Oracle |\n|---|---:|---|---|\n${tests.join('\n')}\n\n` +
    `### Evidence warnings\n\n${evidenceWarnings.length > 0 ? evidenceWarnings.map(item => `- ${markdownCell(item.message || item)}`).join('\n') : '- None.'}\n\n` +
    `### Review findings\n\n${findings.length > 0 ? findings.map(item => `- ${markdownCell(typeof item === 'string' ? item : JSON.stringify(item))}`).join('\n') : '- No unresolved findings.'}\n\n` +
    `> This profile remains \`verified: false\` until confirmed on real hardware.\n`;
}

function writeBlocked(outputDir, context, attempt, evidenceResult, models) {
  const paths = outputPaths(outputDir, context.intake);
  const retryable = evidenceResult.retryable === true;
  const reason = retryable
    ? 'Extracted protocol evidence did not satisfy the automation schema.'
    : 'Protocol evidence is conflicting or ambiguous.';
  const details = [...evidenceResult.conflicts, ...evidenceResult.ambiguities];
  const manifest = {
    issueNumber: context.intake.issueNumber,
    attempt,
    status: 'evidence-blocked',
    retryable,
    code: retryable ? 'EVIDENCE_SCHEMA_INVALID' : 'EVIDENCE_SOURCE_BLOCKED',
    stage: 'evidence',
    reason,
    details,
    reviewMode: models.secondary ? 'multi-model' : 'single-model',
    generatedAt: new Date().toISOString()
  };
  writeJson(paths.context, context);
  writeJson(paths.manifest, manifest);
  writeText(paths.review, `## Automation stopped\n\n${reason}\n\n${details.map(item => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n')}\n`);
  return manifest;
}

function writeGenerationError(outputDir, intake, source, attempt, error) {
  const pathIntake = {
    ...intake,
    vendor: intake.vendor || 'Unknown',
    profileName: intake.profileName || `Unknown-Issue-${intake.issueNumber || 'unknown'}`
  };
  const paths = outputPaths(outputDir, pathIntake);
  const nonRetryableCodes = new Set(['OCR_UNSUPPORTED', 'INTAKE_NOT_READY', 'SOURCE_UNAVAILABLE']);
  const stage = error.stage || (
    error.code === 'INTAKE_NOT_READY'
      ? 'intake'
      : (error.code === 'OCR_UNSUPPORTED' || error.code === 'SOURCE_UNAVAILABLE' ? 'source' : 'generation')
  );
  const manifest = {
    issueNumber: intake.issueNumber,
    attempt,
    status: 'generation-error',
    retryable: !nonRetryableCodes.has(error.code),
    code: error.code || null,
    stage,
    reason: error.message,
    details: [],
    generatedAt: new Date().toISOString()
  };
  writeJson(paths.context, { intake, source: source || null });
  writeJson(paths.manifest, manifest);
  writeText(paths.review, `## Automation generation error\n\n${error.message}\n`);
  return manifest;
}

async function buildCandidate({ models, intake, source, outputDir, attempt = 1, previous = null, validationReport = null, feedback = '' }) {
  const reviewMode = models.secondary ? 'multi-model' : 'single-model';
  logProgress('candidate', 'candidate build started', {
    issue: intake.issueNumber,
    attempt,
    reviewMode,
    primaryModel: models.primary.label,
    secondaryModel: models.secondary && models.secondary.label
  });
  let context;
  if (previous) {
    context = previous.context;
    logProgress('candidate', 'previous candidate loaded for repair', {
      issue: intake.issueNumber,
      attempt,
      previousAttempt: previous.manifest.attempt
    });
  } else {
    const schemaValidationFeedback = validationReport && Array.isArray(validationReport.errors)
      ? validationReport.errors
      : [];
    const evidenceResult = await runStage(
      'evidence',
      () => buildEvidence(models, intake, source, { schemaValidationFeedback }),
      'evidence-build'
    );
    const resolvedIntake = evidenceResult.approved && evidenceResult.consolidated
      ? resolveIntakeMapping(resolveIntakeFPorts(intake, evidenceResult.consolidated), evidenceResult.consolidated)
      : intake;
    context = {
      intake: resolvedIntake,
      source,
      evidence: evidenceResult.consolidated,
      evidenceReviews: evidenceResult.extractions,
      evidenceWarnings: evidenceResult.warnings || [],
      reference: selectReference(resolvedIntake.bacnetMapping, {
        excludePath: resolvedIntake.vendor && resolvedIntake.profileName
          ? `profiles/${resolvedIntake.vendor}/${resolvedIntake.profileName}.yaml`
          : null
      }),
      repositoryExample: loadRepositoryExample(),
      feedback
    };
    logProgress('candidate', 'generation references selected', {
      mappingReference: context.reference && context.reference.path,
      mappingScore: context.reference && context.reference.score,
      repositoryExample: context.repositoryExample.profilePath
    });
    if (!evidenceResult.approved || !evidenceResult.consolidated) {
      return writeBlocked(outputDir, context, attempt, evidenceResult, models);
    }
  }

  const generationStage = previous ? 'repair' : 'generation';
  const raw = await runStage(generationStage, () => (
    previous
      ? repairRawCandidate(models.primary, context, previous, validationReport, feedback)
      : generateRawCandidate(models.primary, context)
  ), previous ? 'profile-repair' : 'profile-generation');
  const previousProfile = previous ? yaml.load(previous.profileYaml) : null;
  const profileYaml = await runStage(
    'normalization',
    () => normalizeProfileYaml(raw.profileYaml, context.intake, previousProfile),
    'profile-normalization'
  );
  const fixture = await runStage(
    'normalization',
    () => normalizeFixture(raw.fixture, context.intake, context.evidence, reviewMode, context.source),
    'fixture-normalization'
  );
  const normalizedProfile = yaml.load(profileYaml);
  logProgress('normalization', 'candidate structure ready', {
    datatypeChannels: Object.keys(normalizedProfile.datatype || {}).length,
    fixtureCases: fixture.testCases.length,
    evidenceLevel: fixture.evidenceLevel
  });
  const reviews = await runStage('review', () => reviewCandidate(models, context, profileYaml, fixture), 'model-reviews');
  logProgress('review', 'review decisions received', {
    protocolApproved: reviews.review.approved,
    adversarialApproved: reviews.adversarial.approved,
    approved: reviews.approved
  });
  const paths = outputPaths(outputDir, context.intake);
  const manifest = {
    issueNumber: context.intake.issueNumber,
    attempt,
    status: reviews.approved ? 'candidate' : 'review-failed',
    retryable: true,
    profilePath: paths.relativeProfile,
    fixturePath: paths.relativeFixture,
    evidenceLevel: fixture.evidenceLevel,
    evidenceWarnings: context.evidenceWarnings || [],
    reviewMode,
    models: [models.primary.label, ...(models.secondary ? [models.secondary.label] : [])],
    review: reviews.review,
    adversarial: reviews.adversarial,
    generatedAt: new Date().toISOString()
  };
  writeText(paths.profile, profileYaml);
  writeJson(paths.fixture, fixture);
  writeJson(paths.context, context);
  writeJson(paths.manifest, manifest);
  writeText(paths.review, buildReviewMarkdown(manifest, context, fixture));
  logProgress('candidate', 'candidate build completed', {
    issue: intake.issueNumber,
    attempt,
    status: manifest.status,
    profilePath: manifest.profilePath,
    fixturePath: manifest.fixturePath
  });
  return manifest;
}

function readCandidate(candidateDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(candidateDir, 'manifest.json'), 'utf8'));
  const context = JSON.parse(fs.readFileSync(path.join(candidateDir, 'context.json'), 'utf8'));
  const profileYaml = manifest.profilePath ? fs.readFileSync(path.join(candidateDir, manifest.profilePath), 'utf8') : '';
  const fixture = manifest.fixturePath ? JSON.parse(fs.readFileSync(path.join(candidateDir, manifest.fixturePath), 'utf8')) : null;
  return { manifest, context, profileYaml, fixture };
}

module.exports = {
  buildCandidate,
  readCandidate,
  outputPaths,
  normalizeCodecSource,
  validateCodecPreflight,
  candidatePreflight,
  normalizeProfileYaml,
  normalizeFixture,
  resolveIntakeFPorts,
  resolveIntakeMapping,
  buildReviewMarkdown,
  writeGenerationError
};
