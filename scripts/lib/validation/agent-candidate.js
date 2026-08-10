'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadYAML } = require('../yaml-parser');
const { validateRequestedMapping } = require('./requested-mapping');
const { validateStrictFixtureRobustness } = require('./test-fixture');
const { runGeneratedProfileCI } = require('../../run-profile-ci');

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function check(valid, errors = [], warnings = []) {
  return { valid, errors, warnings };
}

function validateFixtureContract(fixture, result) {
  const errors = [];
  const warnings = [];
  if (fixture.strict !== true) errors.push('Generated candidate fixture must set strict: true');
  if (!fixture.fPortPolicy) errors.push('Strict candidate fixture must declare fPortPolicy');
  if (!deepEqual(fixture.fPortPolicy, result.fPortPolicy)) errors.push('Fixture and Agent result fPortPolicy must match exactly');
  if (fixture.evidenceLevel !== result.evidenceLevel) errors.push('Fixture and Agent result evidenceLevel must match');
  errors.push(...validateStrictFixtureRobustness(fixture));
  if (fixture.fPortPolicy && fixture.fPortPolicy.mode === 'ignored') {
    if (!fixture.robustness || fixture.robustness.checkUnknownFPort !== false) errors.push('ignored fPort policy must set robustness.checkUnknownFPort to false');
    if (fixture.fPortPolicy.representativeFPort !== 1) warnings.push('ignored fPort convention should use representativeFPort 1 as a test-call placeholder');
  }
  if ((fixture.evidenceLevel === 'known-answer' || fixture.evidenceLevel === 'decoder-derived') &&
      fixture.testCases.some(testCase => !Object.prototype.hasOwnProperty.call(testCase, 'expectedOutput'))) {
    errors.push(`${fixture.evidenceLevel} fixtures require expectedOutput for every test case`);
  }
  if ((result.evidenceMatrix || []).some(row => row.resolution === 'conflict')) errors.push('Agent evidence matrix contains an unresolved conflict');
  return check(errors.length === 0, errors, warnings);
}

function validateIssueCoverage(intake, fixture) {
  const errors = [];
  const fixtureCases = fixture.testCases || [];
  if (fixture.fPortPolicy && fixture.fPortPolicy.mode === 'ignored' &&
      (intake.uplinkExamples || []).some(example => Number.isInteger(example.fPort))) {
    errors.push('ignored fPort policy cannot discard an explicit Issue fPort');
  }
  for (const example of intake.uplinkExamples || []) {
    const matches = fixtureCases.filter(testCase => String(testCase.input).replace(/[^0-9A-Fa-f]/g, '').toUpperCase() === example.hex);
    if (matches.length === 0) {
      errors.push(`Issue payload is not covered by the fixture: ${example.hex}`);
      continue;
    }
    if (Number.isInteger(example.fPort) && fixture.fPortPolicy && fixture.fPortPolicy.mode !== 'ignored' &&
        !matches.some(testCase => testCase.fPort === example.fPort)) {
      errors.push(`Issue payload ${example.hex} is not tested with its explicit fPort ${example.fPort}`);
    }
  }
  return check(errors.length === 0, errors, []);
}

function validateIdentity(profilePath, fixturePath, manifest, intake, result) {
  const errors = [];
  if (manifest.issueNumber !== intake.issueNumber || manifest.issueBodySha !== intake.issueBodySha) errors.push('Candidate artifact is not bound to the source bundle identity');
  if (result.issueNumber !== intake.issueNumber || result.issueBodySha !== intake.issueBodySha) errors.push('Agent result is not bound to the source bundle identity');
  if (manifest.profilePath !== result.profilePath || manifest.fixturePath !== result.fixturePath) errors.push('Manifest and Agent result candidate paths differ');
  if (path.basename(profilePath, '.yaml') !== intake.profileName) errors.push('Profile filename does not match Intake identity');
  if (path.basename(fixturePath, '.test.json') !== intake.profileName) errors.push('Fixture filename does not match Intake identity');
  return check(errors.length === 0, errors, []);
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
  return report;
}

module.exports = {
  validateFixtureContract,
  validateIssueCoverage,
  validateIdentity,
  candidateContractChecks,
  validateAgentCandidate
};
