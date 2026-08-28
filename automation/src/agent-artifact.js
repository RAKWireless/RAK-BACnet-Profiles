'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Ajv = require('ajv');
const {
  WORKSPACE_ROOT,
  AGENT_OUTPUT_SCHEMA_PATH,
  MAX_AGENT_RESULT_BYTES,
  MAX_PATCH_BYTES,
  MAX_PROFILE_BYTES,
  MAX_FIXTURE_BYTES
} = require('./config');
const { ensureParent, readJson, writeJson, writeText } = require('./io');
const { scrubPII } = require('./pii-scrubber');
const { normalizeSourceBundle, validateAgentRequest } = require('./evidence-contract');

const INTERNAL_PREFIXES = ['.profile-agent/', 'automation/.work/'];

function slash(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function expectedPaths(intake) {
  if (!intake.vendor || !intake.profileName) throw new Error('Intake does not contain a valid Profile identity');
  return {
    profilePath: `profiles/${intake.vendor}/${intake.profileName}.yaml`,
    fixturePath: `profiles/${intake.vendor}/tests/${intake.profileName}.test.json`
  };
}

function validateAgentResult(result) {
  const schema = readJson(AGENT_OUTPUT_SCHEMA_PATH);
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (!validate(result)) {
    throw new Error(`Agent result does not match schema: ${validate.errors.map(error => `${error.instancePath || '/'} ${error.message}`).join('; ')}`);
  }
  if (result.status === 'generated') {
    if (!result.profilePath || !result.fixturePath || !result.evidenceLevel || !result.fPortPolicy || result.resolvedMappings.length === 0 || result.evidenceMatrix.length === 0 || result.blocker !== null) {
      throw new Error('Generated Agent result is missing candidate fields or contains a blocker');
    }
  } else if (!result.blocker || result.profilePath !== null || result.fixturePath !== null || result.fPortPolicy !== null) {
    throw new Error('Blocked Agent result must contain a blocker and null candidate fields');
  }
  return result;
}

function validateAgentEvidenceProvenance(result, request) {
  if (result.status !== 'generated') return result;
  const evidence = request && request.evidence;
  if (!evidence || evidence.officialDocument) return result;
  if (!evidence.decoder) throw new Error('Agent generated a candidate without official documentation or decoder evidence');
  if (evidence.decoder.authority !== 'user-provided') {
    throw new Error('Agent generated a decoder-derived candidate from a supporting-only decoder');
  }
  if (result.evidenceLevel !== 'decoder-derived') {
    throw new Error('Agent result without official documentation must use evidenceLevel decoder-derived');
  }
  if (result.evidenceMatrix.length < result.resolvedMappings.length) {
    throw new Error('Decoder-derived Agent result must include evidence for every resolved mapping');
  }
  for (const row of result.evidenceMatrix) {
    if (row.officialDocument !== null) {
      throw new Error('Decoder-derived Agent result must not cite decoder content as official documentation');
    }
    if (!row.decoder || !row.knownPayload || !['decoder-verified', 'payload-verified'].includes(row.resolution)) {
      throw new Error('Decoder-derived Agent result must cite decoder and payload verification for every evidence row');
    }
  }
  return result;
}

function parseAgentResultText(text) {
  const raw = String(text);
  if (Buffer.byteLength(raw, 'utf8') > MAX_AGENT_RESULT_BYTES) {
    throw new Error(`Agent result exceeds ${MAX_AGENT_RESULT_BYTES} bytes`);
  }

  try {
    return JSON.parse(raw);
  } catch (strictError) {
    const lines = raw.replace(/\r\n?/g, '\n').split('\n');
    const fences = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (/^\s*```/.test(lines[index])) fences.push(index);
    }
    if (fences.length === 0) throw strictError;
    if (fences.length !== 2) {
      throw new Error('Agent result must contain exactly one JSON code block when it is not pure JSON');
    }

    const [openingIndex, closingIndex] = fences;
    if (!/^\s*```json\s*$/i.test(lines[openingIndex]) || !/^\s*```\s*$/.test(lines[closingIndex]) || closingIndex <= openingIndex) {
      throw new Error('Agent result fallback accepts only one fenced JSON document');
    }
    const surrounding = [...lines.slice(0, openingIndex), ...lines.slice(closingIndex + 1)].join('\n');
    if (/[{}]/.test(surrounding)) {
      throw new Error('Agent result contains JSON-like content outside the fenced JSON document');
    }

    const fenced = lines.slice(openingIndex + 1, closingIndex).join('\n');
    try {
      return JSON.parse(fenced);
    } catch (error) {
      throw new Error(`Agent result fenced JSON is invalid: ${error.message}`);
    }
  }
}

function readAgentResult(resultPath) {
  const stat = fs.lstatSync(resultPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Agent result must be a regular file');
  if (stat.size > MAX_AGENT_RESULT_BYTES) throw new Error(`Agent result exceeds ${MAX_AGENT_RESULT_BYTES} bytes`);
  return parseAgentResultText(fs.readFileSync(resultPath, 'utf8'));
}

function preserveRawAgentResult(resultPath, outputDirectory) {
  if (!fs.existsSync(resultPath)) return;
  const stat = fs.lstatSync(resultPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_AGENT_RESULT_BYTES) return;
  fs.copyFileSync(resultPath, path.join(outputDirectory, 'agent-result.raw'));
}

function sourceMetadata(source) {
  if (!source) return null;
  return {
    preparedPath: '.profile-agent/input/official-document.txt',
    url: source.url,
    type: source.type,
    pages: source.pages || null,
    sha256: source.sha256 || null
  };
}

function decoderMetadata(decoder) {
  if (!decoder) return null;
  return {
    preparedPath: '.profile-agent/input/decoder.txt',
    url: decoder.url || null,
    origin: decoder.origin || null,
    authority: decoder.authority || 'supporting',
    sha256: decoder.sha256 || null
  };
}

function sourceErrorMetadata(error) {
  if (!error) return null;
  return {
    code: error.code || null,
    stage: error.stage || null
  };
}

function officialAttemptMetadata(attempt) {
  return {
    url: attempt.url || null,
    status: attempt.status,
    sourceError: sourceErrorMetadata(attempt.sourceError),
    extraction: attempt.extraction || null
  };
}

function prepareAgentInput(bundlePath, outputDirectory, options = {}) {
  const bundle = normalizeSourceBundle(readJson(bundlePath));
  if (bundle.error) throw new Error(bundle.error.message || 'Source collection failed');
  if (!bundle.intake || bundle.intake.status !== 'ready') {
    throw new Error(`Issue is not ready for generation: ${bundle.intake && bundle.intake.status}`);
  }
  const intake = bundle.intake;
  const paths = expectedPaths(intake);
  const output = path.resolve(outputDirectory);
  fs.mkdirSync(output, { recursive: true });
  const officialDocumentPath = path.join(output, 'official-document.txt');
  const decoderPath = path.join(output, 'decoder.txt');
  fs.rmSync(officialDocumentPath, { force: true });
  fs.rmSync(decoderPath, { force: true });

  const examples = (intake.uplinkExamples || []).map(({ fPort, explicitFPort, hex }) => ({
    fPort: Number.isInteger(fPort) ? fPort : null,
    explicitFPort: Boolean(explicitFPort),
    hex
  }));
  const downlinkExamples = (intake.downlinkExamples || []).map(example => ({
    command: example.command || null,
    bacnetObject: example.bacnetObject || null,
    fPort: Number.isInteger(example.fPort) ? example.fPort : null,
    value: typeof example.value === 'number' && Number.isFinite(example.value) ? example.value : null,
    hex: example.hex || null,
    allowedValues: example.allowedValues || null,
    expectedResponse: example.expectedResponse || null,
    reference: example.reference || null,
    complete: example.complete === true
  }));
  const supportsDownlink = /^Yes\s*-?\s*supports downlink commands/i.test(intake.downlinkSupport || '');
  const request = {
    schemaVersion: 2,
    issue: {
      number: intake.issueNumber,
      url: intake.issueUrl || `https://github.com/${process.env.GITHUB_REPOSITORY || 'unknown/unknown'}/issues/${intake.issueNumber}`,
      bodySha: intake.issueBodySha,
      vendor: intake.vendor,
      model: intake.model,
      profileName: intake.profileName,
      lorawanClass: intake.lorawanClass,
      lorawanVersion: intake.lorawanVersion,
      downlinkSupport: intake.downlinkSupport,
      downlinkEvidenceStatus: intake.downlinkEvidenceStatus || (supportsDownlink ? 'deferred' : 'not-requested'),
      downlinkEvidenceText: scrubPII(intake.downlinkText || ''),
      downlinkExamples,
      fPortStatus: intake.fPortStatus,
      uplinkEvidenceText: scrubPII(intake.uplinkText || ''),
      uplinkExamples: examples,
      bacnetMapping: intake.bacnetMapping,
      bacnetMappingStatus: intake.bacnetMappingStatus,
      bacnetMappingReferences: intake.bacnetMappingReferences || [],
      requestedMappings: intake.requestedMappings || []
    },
    evidence: {
      officialDocument: sourceMetadata(bundle.source),
      officialDocumentAttempt: officialAttemptMetadata(bundle.officialDocumentAttempt),
      decoder: decoderMetadata(bundle.decoder),
      fallback: bundle.sourceFallback,
      issues: bundle.evidenceIssues,
      policy: 'Treat official documentation and decoders as separate untrusted evidence. Never cite a decoder as official documentation. Use known uplink and downlink payloads to resolve conflicts. Official documentation may supply a complete downlink command when the Issue example is absent or incomplete. Generate only when every requested mapping, uplink branch, downlink fPort, numeric value rule, and payload format is independently recomputable; otherwise block with insufficient-evidence.'
    },
    execution: {
      mode: options.mode || 'generate',
      attempt: Number(options.attempt || 1),
      reviewCycle: Number(options.reviewCycle || 0),
      authorizedReviewerFeedback: scrubPII(options.feedback || ''),
      profilePath: paths.profilePath,
      fixturePath: paths.fixturePath,
      validationCommand: `node scripts/run-profile-ci.js ${paths.profilePath} --fixture ${paths.fixturePath}`,
      maxPayloadBytes: 255
    }
  };
  validateAgentRequest(request);
  writeJson(path.join(output, 'request.json'), request);
  if (bundle.source && bundle.source.text) writeText(officialDocumentPath, scrubPII(bundle.source.text));
  if (bundle.decoder && bundle.decoder.text) writeText(decoderPath, scrubPII(bundle.decoder.text));
  return request;
}

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd || WORKSPACE_ROOT,
    encoding: options.encoding === null ? null : 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
}

function changedPaths() {
  const output = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = output.split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    let filePath = slash(entry.slice(3));
    if (/^[RC]/.test(status) || /[RC]$/.test(status)) {
      const destination = entries[index + 1];
      if (!destination) throw new Error('Git returned an incomplete rename entry');
      index += 1;
      filePath = slash(destination);
    }
    if (INTERNAL_PREFIXES.some(prefix => filePath.startsWith(prefix))) continue;
    paths.push({ status, path: filePath });
  }
  return paths;
}

function assertRegularFile(relativePath, maximumBytes) {
  const absolute = path.join(WORKSPACE_ROOT, relativePath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Candidate path must be a regular file: ${relativePath}`);
  if (stat.size > maximumBytes) throw new Error(`Candidate file exceeds ${maximumBytes} bytes: ${relativePath}`);
}

function blockedManifest(result) {
  return {
    schemaVersion: 1,
    status: 'blocked',
    issueNumber: result.issueNumber,
    issueBodySha: result.issueBodySha,
    retryable: false,
    blocker: result.blocker
  };
}

function captureAgentOutput(resultPath, requestPath, outputDirectory) {
  const request = readJson(requestPath);
  const expected = {
    profilePath: request.execution.profilePath,
    fixturePath: request.execution.fixturePath
  };
  let result;
  try {
    result = validateAgentResult(readAgentResult(resultPath));
    validateAgentEvidenceProvenance(result, request);
  } catch (error) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    const manifest = {
      schemaVersion: 1,
      status: 'invalid-agent-output',
      issueNumber: request.issue.number,
      issueBodySha: request.issue.bodySha,
      retryable: true,
      reason: error.message
    };
    writeJson(path.join(outputDirectory, 'manifest.json'), manifest);
    preserveRawAgentResult(resultPath, outputDirectory);
    return manifest;
  }

  if (result.issueNumber !== request.issue.number || result.issueBodySha !== request.issue.bodySha) {
    throw new Error('Agent result is not bound to the prepared Issue body SHA');
  }
  const changes = changedPaths();
  const unexpected = changes.filter(change => ![expected.profilePath, expected.fixturePath].includes(change.path));
  if (unexpected.length > 0) {
    throw new Error(`Agent changed paths outside the allowlist: ${unexpected.map(change => `${change.status} ${change.path}`).join(', ')}`);
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  writeJson(path.join(outputDirectory, 'agent-result.json'), result);
  if (result.status === 'blocked') {
    const manifest = blockedManifest(result);
    writeJson(path.join(outputDirectory, 'manifest.json'), manifest);
    return manifest;
  }

  if (result.profilePath !== expected.profilePath || result.fixturePath !== expected.fixturePath) {
    throw new Error('Agent result paths do not match the prepared output allowlist');
  }
  for (const expectedPath of Object.values(expected)) {
    if (!changes.some(change => change.path === expectedPath)) throw new Error(`Agent did not produce required candidate path: ${expectedPath}`);
  }
  assertRegularFile(expected.profilePath, MAX_PROFILE_BYTES);
  assertRegularFile(expected.fixturePath, MAX_FIXTURE_BYTES);
  runGit(['add', '-N', '--', expected.profilePath, expected.fixturePath]);
  const patch = runGit(['diff', '--binary', '--full-index', '--no-ext-diff', '--', expected.profilePath, expected.fixturePath]);
  if (!patch.trim()) throw new Error('Agent did not produce a candidate patch');
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) throw new Error(`Candidate patch exceeds ${MAX_PATCH_BYTES} bytes`);
  writeText(path.join(outputDirectory, 'candidate.patch'), patch);
  const manifest = {
    schemaVersion: 1,
    status: 'candidate',
    issueNumber: result.issueNumber,
    issueBodySha: result.issueBodySha,
    retryable: true,
    profilePath: expected.profilePath,
    fixturePath: expected.fixturePath,
    patchSha256: crypto.createHash('sha256').update(patch).digest('hex')
  };
  writeJson(path.join(outputDirectory, 'manifest.json'), manifest);
  return manifest;
}

function patchPaths(patch) {
  const paths = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) continue;
    if (match[1] !== match[2]) throw new Error('Renames are not allowed in candidate patches');
    paths.push(slash(match[1]));
  }
  return [...new Set(paths)];
}

function validateCandidatePatch(candidateDirectory, expectedIssueBodySha) {
  const directory = path.resolve(candidateDirectory);
  const manifest = readJson(path.join(directory, 'manifest.json'));
  if (manifest.status !== 'candidate') throw new Error(`Artifact is not a candidate: ${manifest.status}`);
  if (expectedIssueBodySha && manifest.issueBodySha !== expectedIssueBodySha) throw new Error('Candidate artifact Issue body SHA mismatch');
  const result = validateAgentResult(readJson(path.join(directory, 'agent-result.json')));
  const patchPath = path.join(directory, 'candidate.patch');
  const patch = fs.readFileSync(patchPath, 'utf8');
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) throw new Error(`Candidate patch exceeds ${MAX_PATCH_BYTES} bytes`);
  if (/GIT binary patch|^rename (?:from|to) |^copy (?:from|to) |^old mode |^deleted file mode /m.test(patch)) {
    throw new Error('Binary patches, renames, copies, and mode changes are not allowed');
  }
  for (const match of patch.matchAll(/^new file mode (\d+)$/gm)) {
    if (match[1] !== '100644') throw new Error(`Candidate file mode is not allowed: ${match[1]}`);
  }
  const expected = [manifest.profilePath, manifest.fixturePath].sort();
  const actual = patchPaths(patch).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Candidate patch paths do not match allowlist: ${actual.join(', ')}`);
  }
  const sha = crypto.createHash('sha256').update(patch).digest('hex');
  if (sha !== manifest.patchSha256) throw new Error('Candidate patch SHA-256 mismatch');
  if (result.issueBodySha !== manifest.issueBodySha || result.issueNumber !== manifest.issueNumber) {
    throw new Error('Candidate manifest and Agent result identity mismatch');
  }
  runGit(['apply', '--check', '--whitespace=error-all', patchPath]);
  return { manifest, result, patchPath };
}

function applyCandidatePatch(candidateDirectory, expectedIssueBodySha) {
  const checked = validateCandidatePatch(candidateDirectory, expectedIssueBodySha);
  runGit(['apply', '--whitespace=error-all', checked.patchPath]);
  assertRegularFile(checked.manifest.profilePath, MAX_PROFILE_BYTES);
  assertRegularFile(checked.manifest.fixturePath, MAX_FIXTURE_BYTES);
  return checked;
}

function copyPreviousInputs(requestPath) {
  const request = readJson(requestPath);
  const previousRoot = path.join(path.dirname(requestPath), 'previous');
  for (const relativePath of [request.execution.profilePath, request.execution.fixturePath]) {
    const source = path.join(WORKSPACE_ROOT, relativePath);
    if (!fs.existsSync(source)) throw new Error(`Previous candidate is missing: ${relativePath}`);
    const destination = path.join(previousRoot, relativePath);
    ensureParent(destination);
    fs.copyFileSync(source, destination);
  }
}

function seedPreviousFromCandidate(candidateDirectory, requestPath, validationReportPath) {
  const request = readJson(requestPath);
  const candidateRoot = path.resolve(candidateDirectory);
  const manifest = readJson(path.join(candidateRoot, 'manifest.json'));
  let candidateSeeded = false;
  if (manifest.status === 'candidate') {
    applyCandidatePatch(candidateRoot, request.issue.bodySha);
    copyPreviousInputs(requestPath);
    candidateSeeded = true;
  } else {
    if (manifest.issueNumber !== request.issue.number || manifest.issueBodySha !== request.issue.bodySha) {
      throw new Error('Previous attempt identity does not match the prepared request');
    }
    if (manifest.retryable !== true) throw new Error(`Previous attempt is not retryable: ${manifest.status}`);
    const previousRoot = path.join(path.dirname(requestPath), 'previous');
    writeJson(path.join(previousRoot, 'manifest.json'), manifest);
    const rawResultPath = path.join(candidateRoot, 'agent-result.raw');
    if (fs.existsSync(rawResultPath)) fs.copyFileSync(rawResultPath, path.join(previousRoot, 'agent-result.raw'));
  }
  if (validationReportPath) {
    fs.copyFileSync(validationReportPath, path.join(path.dirname(requestPath), 'validation-report.json'));
  }
  return { status: manifest.status, candidateSeeded };
}

function seedPreviousFromRef(ref, requestPath) {
  if (!/^auto-profile-\d+$/.test(ref)) throw new Error(`Invalid automated Profile branch: ${ref}`);
  const request = readJson(requestPath);
  for (const relativePath of [request.execution.profilePath, request.execution.fixturePath]) {
    const content = runGit(['show', `${ref}:${relativePath}`]);
    const destination = path.join(WORKSPACE_ROOT, relativePath);
    ensureParent(destination);
    fs.writeFileSync(destination, content, 'utf8');
  }
  copyPreviousInputs(requestPath);
}

function removeShadowTargets(requestPath) {
  const request = readJson(requestPath);
  for (const relativePath of [request.execution.profilePath, request.execution.fixturePath]) {
    const absolute = path.join(WORKSPACE_ROOT, relativePath);
    if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
  }
}

module.exports = {
  expectedPaths,
  validateAgentResult,
  validateAgentEvidenceProvenance,
  parseAgentResultText,
  readAgentResult,
  prepareAgentInput,
  captureAgentOutput,
  validateCandidatePatch,
  applyCandidatePatch,
  seedPreviousFromCandidate,
  seedPreviousFromRef,
  removeShadowTargets,
  changedPaths,
  patchPaths,
  blockedManifest
};
