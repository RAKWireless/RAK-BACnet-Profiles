'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { completeJson } = require('./model-client');
const { loadPrompt } = require('./prompt-loader');
const { buildEvidence } = require('./evidence');
const { selectReference } = require('./reference-selector');
const { normalizeHex } = require('./issue-parser');
const { writeJson, writeText } = require('./io');

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

function normalizeProfileYaml(rawYaml, intake, previousProfile = null) {
  const parsed = yaml.load(String(rawYaml || ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Generated profileYaml must contain one YAML object');
  if (typeof parsed.codec !== 'string') throw new Error('Generated profileYaml is missing a codec string');
  if (!parsed.datatype || typeof parsed.datatype !== 'object') throw new Error('Generated profileYaml is missing datatype mappings');

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
    codec: parsed.codec,
    datatype: parsed.datatype,
    lorawan,
    ...profileIdentity(intake, previousProfile)
  };
  return yaml.dump(ordered, { noRefs: true, lineWidth: -1, sortKeys: false, quotingType: '"' });
}

function normalizedKnownAnswers(evidence) {
  return (evidence.knownAnswers || []).map(answer => ({
    ...answer,
    normalizedInput: normalizeHex(answer.input),
    fPort: Number(answer.fPort)
  }));
}

function normalizeFixture(rawFixture, intake, evidence, reviewMode, source = null) {
  const supplied = Array.isArray(rawFixture && rawFixture.testCases) ? rawFixture.testCases : [];
  const knownAnswers = normalizedKnownAnswers(evidence);
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

  return {
    schemaVersion: 1,
    profile: intake.profileName,
    evidenceLevel: applicableKnownAnswers.length > 0 ? 'known-answer' : 'documentation-only',
    reviewMode,
    sources: [
      { type: 'issue', reference: intake.issueUrl || `Issue #${intake.issueNumber}`, citation: 'Uplink examples and requested BACnet mapping' },
      {
        type: 'official-document',
        reference: (source && source.url) || intake.datasheetUrl,
        citation: source && source.sha256 ? `Protocol documentation SHA-256: ${source.sha256}` : 'Protocol documentation used during generation'
      },
      ...(intake.decoder ? [{ type: 'customer-data', reference: intake.issueUrl || `Issue #${intake.issueNumber}`, citation: 'Decoder supplied in the Issue' }] : [])
    ],
    robustness: { checkTruncation: true, checkUnknownFPort: true },
    testCases
  };
}

function generationUserContent(context) {
  return JSON.stringify({
    issue: context.intake,
    officialDocument: { ...context.source, text: context.source.text },
    evidence: context.evidence,
    mappingReference: context.reference,
    authorizedMaintainerFeedback: context.feedback || ''
  });
}

async function generateRawCandidate(model, context) {
  return completeJson(model, [
    { role: 'system', content: loadPrompt('generate-profile') },
    { role: 'user', content: generationUserContent(context) }
  ]);
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
        previousProfileYaml: previous.profileYaml,
        previousFixture: previous.fixture,
        validationReport,
        authorizedMaintainerFeedback: feedback || ''
      })
    }
  ]);
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
    fixture
  });
  const reviewerModel = models.secondary || models.primary;
  const review = normalizeReview(await completeJson(reviewerModel, [
    { role: 'system', content: loadPrompt('review-profile') },
    { role: 'user', content: payload }
  ]));
  const adversarial = normalizeReview(await completeJson(models.primary, [
    { role: 'system', content: loadPrompt('adversarial-review') },
    { role: 'user', content: payload }
  ]));
  return { review, adversarial, approved: review.approved && adversarial.approved };
}

function evidenceFieldRows(evidence) {
  const rows = [];
  for (const message of evidence.messageTypes || []) {
    for (const field of message.fields || []) {
      rows.push(`| ${markdownCell(message.name)} | ${markdownCell(field.name)} | ${markdownCell(field.offset)} | ${markdownCell(field.length)} | ${markdownCell(field.endianness)} | ${markdownCell(field.formula ?? field.scale)} | ${markdownCell(field.citation || message.citation)} |`);
    }
  }
  return rows;
}

function buildReviewMarkdown(manifest, context, fixture) {
  const rows = evidenceFieldRows(context.evidence);
  const tests = fixture.testCases.map(testCase => `| ${testCase.name} | ${testCase.fPort} | ${testCase.input} | ${Object.prototype.hasOwnProperty.call(testCase, 'expectedOutput') ? 'Known answer' : 'Execution + documentation review'} |`);
  const findings = [...manifest.review.findings, ...manifest.adversarial.findings];
  return `## Automated Profile Evidence\n\n` +
    `- Issue: #${context.intake.issueNumber}\n` +
    `- Evidence level: **${manifest.evidenceLevel}**\n` +
    `- Model review: **${manifest.reviewMode}**\n` +
    `- Supported scope: **uplink only**\n` +
    `- Hardware verified: **no**\n\n` +
    `### Sources\n\n` +
    `- ${context.source.url} (${context.source.type}${context.source.pages ? `, ${context.source.pages} pages` : ''}; SHA-256: \`${context.source.sha256}\`)\n` +
    `- ${context.intake.issueUrl || `Issue #${context.intake.issueNumber}`}\n\n` +
    `### Protocol field checks\n\n` +
    `| Message | Field | Offset | Length | Endian | Formula | Citation |\n|---|---|---:|---:|---|---|---|\n` +
    `${rows.length > 0 ? rows.join('\n') : '| — | — | — | — | — | — | No structured rows returned |'}\n\n` +
    `### BACnet mapping requested by submitter\n\n${indentedCode(context.intake.bacnetMapping)}\n\n` +
    `### Test coverage\n\n| Test | fPort | Payload | Oracle |\n|---|---:|---|---|\n${tests.join('\n')}\n\n` +
    `### Review findings\n\n${findings.length > 0 ? findings.map(item => `- ${markdownCell(typeof item === 'string' ? item : JSON.stringify(item))}`).join('\n') : '- No unresolved findings.'}\n\n` +
    `> This profile remains \`verified: false\` until confirmed on real hardware.\n`;
}

function writeBlocked(outputDir, context, attempt, reason, details, models) {
  const paths = outputPaths(outputDir, context.intake);
  const manifest = {
    issueNumber: context.intake.issueNumber,
    attempt,
    status: 'evidence-blocked',
    retryable: false,
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
  const manifest = {
    issueNumber: intake.issueNumber,
    attempt,
    status: 'generation-error',
    retryable: !nonRetryableCodes.has(error.code),
    code: error.code || null,
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
  let context;
  if (previous) {
    context = previous.context;
  } else {
    const evidenceResult = await buildEvidence(models, intake, source);
    context = {
      intake,
      source,
      evidence: evidenceResult.consolidated,
      evidenceReviews: evidenceResult.extractions,
      reference: selectReference(intake.bacnetMapping),
      feedback
    };
    if (!evidenceResult.approved || !evidenceResult.consolidated) {
      return writeBlocked(outputDir, context, attempt, 'Protocol evidence is conflicting or ambiguous.', [...evidenceResult.conflicts, ...evidenceResult.ambiguities], models);
    }
  }

  const raw = previous
    ? await repairRawCandidate(models.primary, context, previous, validationReport, feedback)
    : await generateRawCandidate(models.primary, context);
  const previousProfile = previous ? yaml.load(previous.profileYaml) : null;
  const profileYaml = normalizeProfileYaml(raw.profileYaml, context.intake, previousProfile);
  const fixture = normalizeFixture(raw.fixture, context.intake, context.evidence, reviewMode, context.source);
  const reviews = await reviewCandidate(models, context, profileYaml, fixture);
  const paths = outputPaths(outputDir, context.intake);
  const manifest = {
    issueNumber: context.intake.issueNumber,
    attempt,
    status: reviews.approved ? 'candidate' : 'review-failed',
    retryable: true,
    profilePath: paths.relativeProfile,
    fixturePath: paths.relativeFixture,
    evidenceLevel: fixture.evidenceLevel,
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
  return manifest;
}

function readCandidate(candidateDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(candidateDir, 'manifest.json'), 'utf8'));
  const context = JSON.parse(fs.readFileSync(path.join(candidateDir, 'context.json'), 'utf8'));
  const profileYaml = manifest.profilePath ? fs.readFileSync(path.join(candidateDir, manifest.profilePath), 'utf8') : '';
  const fixture = manifest.fixturePath ? JSON.parse(fs.readFileSync(path.join(candidateDir, manifest.fixturePath), 'utf8')) : null;
  return { manifest, context, profileYaml, fixture };
}

module.exports = { buildCandidate, readCandidate, outputPaths, normalizeProfileYaml, normalizeFixture, buildReviewMarkdown, writeGenerationError };
