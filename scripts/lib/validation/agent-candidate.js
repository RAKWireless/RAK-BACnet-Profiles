'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadYAML } = require('../yaml-parser');
const { validateRequestedMapping } = require('./requested-mapping');
const { validateStrictFixtureRobustnessDetails } = require('./test-fixture');
const { firstDifference, boundedExpectedActual } = require('./diagnostics');
const { runGeneratedProfileCI } = require('../../run-profile-ci');

const ALLOWED_CHECK_PATHS = Object.freeze([
  'identity',
  'fixtureContract',
  'issueCoverage',
  'requestedMapping',
  'candidateStrict.checks.yaml',
  'candidateStrict.checks.schema',
  'candidateStrict.checks.requiredFields',
  'candidateStrict.checks.codecSafety',
  'candidateStrict.checks.codecSyntax',
  'candidateStrict.checks.bacnet',
  'candidateStrict.checks.naming',
  'candidateStrict.checks.semantics',
  'candidateStrict.checks.fixture',
  'repositoryProfiles',
  'repositoryFixtures',
  'registryUpdate',
  'registryValidation',
  'validation'
]);
const ALLOWED_CHECK_PATH_SET = new Set(ALLOWED_CHECK_PATHS);

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function check(valid, errors = [], warnings = [], failures = []) {
  return { valid, errors, warnings, failures };
}

function validationErrorFailure(checkPath, message, field) {
  return {
    code: 'VALIDATION_ERROR',
    checkPath,
    message,
    field,
    rule: 'The deterministic validator must pass without errors',
    hint: 'Resolve this validation error without weakening tests or validation rules'
  };
}

function addFailure(errors, failures, code, checkPath, message, detail = {}) {
  errors.push(message);
  failures.push({ code, checkPath, message, ...detail });
}

function addLegacyFailures(errors, failures, checkPath) {
  const covered = new Set(failures.map(failure => failure.message));
  for (const [index, message] of errors.entries()) {
    if (!covered.has(message)) failures.push(validationErrorFailure(checkPath, message, `errors[${index}]`));
  }
}

function validateFixtureContract(fixture, result) {
  const errors = [];
  const warnings = [];
  const failures = [];
  if (fixture.strict !== true) {
    addFailure(errors, failures, 'FIXTURE_STRICT_REQUIRED', 'fixtureContract', 'Generated candidate fixture must set strict: true', {
      field: 'strict',
      rule: 'Generated candidate fixtures must set strict to true',
      hint: 'Set strict to true and satisfy all strict robustness checks'
    });
  }
  if (!fixture.fPortPolicy) {
    addFailure(errors, failures, 'FIXTURE_FPORT_POLICY_MISMATCH', 'fixtureContract', 'Strict candidate fixture must declare fPortPolicy', {
      field: 'fPortPolicy',
      rule: 'Every strict fixture must declare the evidence-backed fPort policy',
      hint: 'Add a fixed, agnostic, or ignored fPortPolicy supported by the prepared evidence'
    });
  }
  if (!deepEqual(fixture.fPortPolicy, result.fPortPolicy)) {
    const snapshots = boundedExpectedActual(result.fPortPolicy, fixture.fPortPolicy);
    addFailure(errors, failures, 'FIXTURE_FPORT_POLICY_MISMATCH', 'fixtureContract', 'Fixture and Agent result fPortPolicy must match exactly', {
      field: 'fPortPolicy',
      rule: 'Fixture and Agent result fPortPolicy values must be identical',
      hint: 'Resolve the evidence-backed policy once and use the same object in the fixture and Agent result',
      expected: snapshots.expected,
      actual: snapshots.actual,
      difference: firstDifference(result.fPortPolicy, fixture.fPortPolicy),
      truncated: snapshots.truncated,
      truncatedFields: snapshots.truncatedFields
    });
  }
  if (fixture.evidenceLevel !== result.evidenceLevel) errors.push('Fixture and Agent result evidenceLevel must match');
  const robustness = validateStrictFixtureRobustnessDetails(fixture, 'fixtureContract');
  errors.push(...robustness.errors);
  failures.push(...robustness.failures);
  if (fixture.fPortPolicy && fixture.fPortPolicy.mode === 'ignored') {
    if (!fixture.robustness || fixture.robustness.checkUnknownFPort !== false) {
      addFailure(errors, failures, 'FIXTURE_FPORT_POLICY_MISMATCH', 'fixtureContract', 'ignored fPort policy must set robustness.checkUnknownFPort to false', {
        field: 'robustness.checkUnknownFPort',
        rule: 'An ignored fPort policy must not run the unknown-fPort rejection check',
        hint: 'Set robustness.checkUnknownFPort to false only when the evidence supports an ignored fPort policy'
      });
    }
    if (fixture.fPortPolicy.representativeFPort !== 1) warnings.push('ignored fPort convention should use representativeFPort 1 as a test-call placeholder');
  }
  if ((fixture.evidenceLevel === 'known-answer' || fixture.evidenceLevel === 'decoder-derived') &&
      fixture.testCases.some(testCase => !Object.prototype.hasOwnProperty.call(testCase, 'expectedOutput'))) {
    errors.push(`${fixture.evidenceLevel} fixtures require expectedOutput for every test case`);
  }
  if ((result.evidenceMatrix || []).some(row => row.resolution === 'conflict')) errors.push('Agent evidence matrix contains an unresolved conflict');
  addLegacyFailures(errors, failures, 'fixtureContract');
  return check(errors.length === 0, errors, warnings, failures);
}

function validateIssueCoverage(intake, fixture) {
  const errors = [];
  const failures = [];
  const fixtureCases = fixture.testCases || [];
  if (fixture.fPortPolicy && fixture.fPortPolicy.mode === 'ignored' &&
      (intake.uplinkExamples || []).some(example => Number.isInteger(example.fPort))) {
    addFailure(errors, failures, 'IGNORED_FPORT_CONFLICT', 'issueCoverage', 'ignored fPort policy cannot discard an explicit Issue fPort', {
      field: 'fPortPolicy',
      rule: 'An explicit Issue fPort must be preserved by the fixture policy',
      hint: 'Use a fixed fPort policy containing every explicit Issue fPort'
    });
  }
  for (const example of intake.uplinkExamples || []) {
    const matches = fixtureCases.filter(testCase => String(testCase.input).replace(/[^0-9A-Fa-f]/g, '').toUpperCase() === example.hex);
    if (matches.length === 0) {
      addFailure(errors, failures, 'ISSUE_PAYLOAD_NOT_COVERED', 'issueCoverage', `Issue payload is not covered by the fixture: ${example.hex}`, {
        payload: example.hex,
        fPort: Number.isInteger(example.fPort) ? example.fPort : null,
        field: 'testCases',
        rule: 'Every Issue payload must appear in the strict fixture',
        hint: 'Add a strict test case for this exact normalized payload and its evidence-backed expected output'
      });
      continue;
    }
    if (Number.isInteger(example.fPort) && fixture.fPortPolicy && fixture.fPortPolicy.mode !== 'ignored' &&
        !matches.some(testCase => testCase.fPort === example.fPort)) {
      addFailure(errors, failures, 'ISSUE_FPORT_NOT_COVERED', 'issueCoverage', `Issue payload ${example.hex} is not tested with its explicit fPort ${example.fPort}`, {
        payload: example.hex,
        fPort: example.fPort,
        field: 'testCases.fPort',
        rule: 'Every explicit Issue fPort must be reproduced by a matching fixture test case',
        hint: `Test this payload with fPort ${example.fPort} and keep the fixed policy consistent`
      });
    }
  }
  const downlinkCases = fixture.downlinkTestCases || [];
  for (const example of (intake.downlinkExamples || []).filter(item => item.complete === true)) {
    const matches = downlinkCases.filter(testCase => (
      String(testCase.expectedBytes || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase() === example.hex &&
      testCase.expectedFPort === example.fPort &&
      testCase.value === example.value
    ));
    if (matches.length === 0) {
      addFailure(errors, failures, 'ISSUE_DOWNLINK_NOT_COVERED', 'issueCoverage', `Issue downlink is not covered by the fixture: ${example.command || example.hex}`, {
        payload: example.hex,
        fPort: example.fPort,
        value: example.value,
        field: 'downlinkTestCases',
        rule: 'Every complete Issue downlink example must appear in the strict fixture',
        hint: 'Add a downlink test case with this exact numeric value, fPort, and normalized expected payload'
      });
    }
  }
  return check(errors.length === 0, errors, [], failures);
}

function validateIdentity(profilePath, fixturePath, manifest, intake, result) {
  const errors = [];
  if (manifest.issueNumber !== intake.issueNumber || manifest.issueBodySha !== intake.issueBodySha) errors.push('Candidate artifact is not bound to the source bundle identity');
  if (result.issueNumber !== intake.issueNumber || result.issueBodySha !== intake.issueBodySha) errors.push('Agent result is not bound to the source bundle identity');
  if (manifest.profilePath !== result.profilePath || manifest.fixturePath !== result.fixturePath) errors.push('Manifest and Agent result candidate paths differ');
  if (path.basename(profilePath, '.yaml') !== intake.profileName) errors.push('Profile filename does not match Intake identity');
  if (path.basename(fixturePath, '.test.json') !== intake.profileName) errors.push('Fixture filename does not match Intake identity');
  const failures = errors.map((message, index) => validationErrorFailure('identity', message, `errors[${index}]`));
  return check(errors.length === 0, errors, [], failures);
}

function mappingRequest(intake, result) {
  if (intake.bacnetMappingStatus !== 'deferred') return intake.bacnetMapping;
  return (result.resolvedMappings || []).map(mapping => (
    `${mapping.name} -> ${mapping.type}${mapping.units ? ` (${mapping.units})` : ''}`
  )).join('\n');
}

function candidateContractChecks({ profilePath, fixturePath, manifest, result, sourceBundle }) {
  const profile = loadYAML(profilePath);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const checks = {
    identity: validateIdentity(profilePath, fixturePath, manifest, sourceBundle.intake, result),
    fixtureContract: validateFixtureContract(fixture, result),
    issueCoverage: validateIssueCoverage(sourceBundle.intake, fixture),
    requestedMapping: validateRequestedMapping(profile, mappingRequest(sourceBundle.intake, result)),
    candidateStrict: runGeneratedProfileCI(profilePath, fixturePath)
  };
  return { checks, valid: Object.values(checks).every(item => item.valid) };
}

function runCommand(root, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024
  });
  const errors = [];
  if (result.error) errors.push(result.error.message);
  if (result.status !== 0) {
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(-8000);
    errors.push(detail || `Command exited with status ${result.status}`);
  }
  return check(errors.length === 0, errors, []);
}

function nestedCheckEntries(checks) {
  const entries = [];
  for (const [name, checkResult] of Object.entries(checks || {})) {
    if (name === 'candidateStrict' && checkResult && checkResult.checks) {
      for (const [nestedName, nestedResult] of Object.entries(checkResult.checks)) {
        entries.push({ checkPath: `candidateStrict.checks.${nestedName}`, check: nestedResult });
      }
      continue;
    }
    entries.push({ checkPath: name, check: checkResult });
  }
  return entries;
}

function failurePriority(failure) {
  if (failure.checkPath === 'validation' || [
    'candidateStrict.checks.yaml',
    'candidateStrict.checks.schema',
    'candidateStrict.checks.requiredFields',
    'candidateStrict.checks.codecSafety',
    'candidateStrict.checks.codecSyntax'
  ].includes(failure.checkPath)) return 0;
  if (failure.checkPath === 'identity') return 1;
  if (failure.checkPath === 'fixtureContract' || failure.code === 'FIXTURE_STRICT_REQUIRED' || failure.code === 'FIXTURE_FPORT_POLICY_MISMATCH') return 2;
  if (failure.checkPath === 'issueCoverage') return 3;
  if (failure.code === 'FIXTURE_EXPECTED_OUTPUT_MISMATCH' || failure.code === 'FIXTURE_EXPECTED_BYTES_MISMATCH') return 4;
  if (failure.checkPath === 'requestedMapping') return 5;
  if (failure.checkPath.startsWith('candidateStrict.checks.')) return 6;
  return 7;
}

function compareFailures(left, right) {
  const priority = failurePriority(left) - failurePriority(right);
  if (priority !== 0) return priority;
  for (const field of ['checkPath', 'code', 'testCase', 'payload', 'field']) {
    const compared = String(left[field] ?? '').localeCompare(String(right[field] ?? ''));
    if (compared !== 0) return compared;
  }
  return 0;
}

function repairFailures(report) {
  const collected = [];
  for (const { checkPath, check: checkResult } of nestedCheckEntries(report.checks)) {
    if (!checkResult || typeof checkResult !== 'object') continue;
    const sourceFailures = Array.isArray(checkResult.failures) ? checkResult.failures : [];
    for (const failure of sourceFailures) {
      collected.push({ ...failure, checkPath });
    }
    const represented = new Set();
    for (const failure of sourceFailures) {
      represented.add(failure.message);
      if (failure.testCase) represented.add(`${failure.testCase}: ${failure.message}`);
    }
    for (const [index, message] of (checkResult.errors || []).entries()) {
      if (!represented.has(message)) collected.push(validationErrorFailure(checkPath, message, `errors[${index}]`));
    }
    if (checkResult.valid === false && sourceFailures.length === 0 && (checkResult.errors || []).length === 0) {
      collected.push(validationErrorFailure(checkPath, 'Check failed without diagnostic errors', 'valid'));
    }
  }
  if (report.error) collected.push(validationErrorFailure('validation', report.error, 'error'));

  const unique = new Map();
  for (const failure of collected) {
    const checkPath = ALLOWED_CHECK_PATH_SET.has(failure.checkPath) ? failure.checkPath : 'validation';
    const normalized = { ...failure, checkPath };
    const key = ['code', 'checkPath', 'testCase', 'payload', 'field']
      .map(field => String(normalized[field] ?? ''))
      .join('\u0000');
    if (!unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.values()].sort(compareFailures);
}

function validateAgentCandidate({ root, candidateDirectory, sourceBundlePath, includeRepositoryChecks = true }) {
  const directory = path.resolve(candidateDirectory);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const result = JSON.parse(fs.readFileSync(path.join(directory, 'agent-result.json'), 'utf8'));
  const sourceBundle = JSON.parse(fs.readFileSync(sourceBundlePath, 'utf8'));
  const profilePath = path.join(root, manifest.profilePath);
  const fixturePath = path.join(root, manifest.fixturePath);
  const report = {
    schemaVersion: 1,
    issueNumber: manifest.issueNumber,
    issueBodySha: manifest.issueBodySha,
    profilePath: manifest.profilePath,
    fixturePath: manifest.fixturePath,
    valid: false,
    retryable: true,
    checks: {}
  };
  try {
    const contract = candidateContractChecks({ profilePath, fixturePath, manifest, result, sourceBundle });
    Object.assign(report.checks, contract.checks);
    if (includeRepositoryChecks) {
      report.checks.repositoryProfiles = runCommand(root, ['scripts/validate-all.js', '--json']);
      report.checks.repositoryFixtures = runCommand(root, ['scripts/validate-committed-fixtures.js', '--json']);
      report.checks.registryUpdate = runCommand(root, ['scripts/update-registry.js']);
      report.checks.registryValidation = report.checks.registryUpdate.valid
        ? runCommand(root, ['scripts/validate-registry.js'])
        : check(false, ['Registry validation skipped because registry update failed'], []);
    }
    report.valid = Object.values(report.checks).every(item => item.valid);
  } catch (error) {
    report.error = error.message;
    report.valid = false;
  }
  if (!report.valid) {
    const failures = repairFailures(report);
    report.repair = {
      primaryFailure: failures[0] || validationErrorFailure('validation', 'Candidate validation failed without diagnostics', 'valid'),
      failures: failures.length > 0 ? failures : [validationErrorFailure('validation', 'Candidate validation failed without diagnostics', 'valid')]
    };
  }
  return report;
}

module.exports = {
  validateFixtureContract,
  validateIssueCoverage,
  validateIdentity,
  candidateContractChecks,
  validateAgentCandidate,
  repairFailures,
  ALLOWED_CHECK_PATHS
};
