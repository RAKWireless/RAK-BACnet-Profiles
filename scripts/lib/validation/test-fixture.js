#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const { loadYAML } = require('../yaml-parser');
const { hexToBytes } = require('../hex-converter');
const { testDecode } = require('../../test-codec');
const { validateDecodedData } = require('./profile-semantics');
const { firstDifference, boundedExpectedActual } = require('./diagnostics');

function deepEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function validateFixtureSchema(fixture) {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schemas', 'profile-test-schema.json'), 'utf8'));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  const valid = validate(fixture);
  return {
    valid,
    errors: valid ? [] : validate.errors.map(error => `${error.instancePath || '/'} ${error.message}`)
  };
}

function validationErrorFailure(checkPath, message, extra = {}) {
  return {
    code: 'VALIDATION_ERROR',
    checkPath,
    message,
    rule: 'The deterministic validator must pass without errors',
    hint: 'Resolve this validation error without weakening the fixture or validation rules',
    ...extra
  };
}

function validateStrictFixtureRobustnessDetails(fixture, checkPath = 'candidateStrict.checks.fixture') {
  if (fixture.strict !== true) return { errors: [], failures: [] };
  const errors = [];
  const failures = [];
  if (!fixture.robustness || fixture.robustness.checkTruncation !== true) {
    const message = 'Strict fixture must set robustness.checkTruncation to true';
    errors.push(message);
    failures.push({
      code: 'FIXTURE_STRICT_REQUIRED',
      checkPath,
      message,
      field: 'robustness.checkTruncation',
      rule: 'Strict generated fixtures must enable truncation checks',
      hint: 'Set robustness.checkTruncation to true and make the codec fail closed on every truncated payload'
    });
  }
  if (!fixture.robustness || fixture.robustness.checkFuzz !== true) {
    const message = 'Strict fixture must set robustness.checkFuzz to true';
    errors.push(message);
    failures.push({
      code: 'FIXTURE_STRICT_REQUIRED',
      checkPath,
      message,
      field: 'robustness.checkFuzz',
      rule: 'Strict generated fixtures must enable deterministic fuzz checks',
      hint: 'Set robustness.checkFuzz to true and make malformed payloads fail closed deterministically'
    });
  }
  return { errors, failures };
}

function validateStrictFixtureRobustness(fixture) {
  return validateStrictFixtureRobustnessDetails(fixture).errors;
}

function validateResult(profile, testCase, result, valueOptions = {}, failureOptions = {}) {
  const errors = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) return ['decodeUplink must return an object'];
  if (result.data !== undefined && !Array.isArray(result.data)) errors.push('decodeUplink.data must be an array when present');
  if (valueOptions.requireCanonicalReturn === true && Object.prototype.hasOwnProperty.call(result, 'errors')) {
    if (!Array.isArray(result.errors) || result.errors.length === 0 || result.errors.some(error => typeof error !== 'string' || error.length === 0)) {
      errors.push('decodeUplink must omit errors on success and use a non-empty string array only on failure');
    }
    if (Array.isArray(result.data) && result.data.length > 0) {
      errors.push('decodeUplink must not return BACnet data together with errors');
    }
  }
  const semantic = validateDecodedData(profile, result.data || [], valueOptions);
  errors.push(...semantic.errors);
  if (Object.prototype.hasOwnProperty.call(testCase, 'expectedOutput') && !deepEqual(result.data || [], testCase.expectedOutput)) {
    const message = 'Actual output does not match expectedOutput';
    errors.push(message);
    if (Array.isArray(failureOptions.failures)) {
      const expected = testCase.expectedOutput;
      const actual = result.data || [];
      const snapshots = boundedExpectedActual(expected, actual);
      failureOptions.failures.push({
        code: 'FIXTURE_EXPECTED_OUTPUT_MISMATCH',
        checkPath: failureOptions.checkPath || 'candidateStrict.checks.fixture',
        message,
        testCase: testCase.name,
        payload: String(testCase.input || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase(),
        fPort: testCase.fPort,
        field: 'expectedOutput',
        rule: 'Decoded BACnet rows must exactly match expectedOutput',
        hint: 'Compare the first difference with the protocol evidence and repair the codec unless the fixture oracle is proven wrong',
        expected: snapshots.expected,
        actual: snapshots.actual,
        difference: firstDifference(expected, actual),
        truncated: snapshots.truncated,
        truncatedFields: snapshots.truncatedFields
      });
    }
  }
  return errors;
}

function validateTruncation(profile, testCase, valueOptions) {
  const errors = [];
  const bytes = hexToBytes(testCase.input);
  const lengths = new Set();
  for (let length = 0; length < Math.min(bytes.length, 32); length += 1) lengths.add(length);
  for (let length = Math.max(0, bytes.length - 32); length < bytes.length; length += 1) lengths.add(length);
  for (const length of [...lengths].sort((a, b) => a - b)) {
    const truncated = bytes.slice(0, length).map(byte => byte.toString(16).padStart(2, '0')).join('');
    try {
      const result = testDecode(profile.codec, testCase.fPort, truncated);
      const truncatedCase = { ...testCase };
      delete truncatedCase.expectedOutput;
      errors.push(...validateResult(profile, truncatedCase, result, valueOptions).map(error => `truncated length ${length}: ${error}`));
      if (Array.isArray(result.data) && result.data.length > 0) {
        errors.push(`truncated length ${length}: decoder produced BACnet data`);
      }
      if (!Array.isArray(result.errors) || result.errors.length === 0) {
        errors.push(`truncated length ${length}: decoder must return an errors array`);
      }
    } catch (error) {
      errors.push(`truncated length ${length} threw: ${error.message}`);
    }
  }
  return errors;
}

function validateUnknownFPort(profile, testCase, knownFPorts, valueOptions) {
  let unknownFPort = null;
  for (let candidate = 223; candidate >= 0; candidate -= 1) {
    if (!knownFPorts.has(candidate)) {
      unknownFPort = candidate;
      break;
    }
  }
  if (unknownFPort === null) return ['No unused fPort is available for the robustness check'];
  try {
    const result = testDecode(profile.codec, unknownFPort, testCase.input);
    const unknownCase = { ...testCase };
    delete unknownCase.expectedOutput;
    const errors = validateResult(profile, unknownCase, result, valueOptions);
    if (Array.isArray(result.data) && result.data.length > 0) {
      errors.push(`unknown fPort ${unknownFPort} produced BACnet data`);
    }
    if (!Array.isArray(result.errors) || result.errors.length === 0) {
      errors.push(`unknown fPort ${unknownFPort} must return an errors array`);
    }
    return errors;
  } catch (error) {
    return [`unknown fPort ${unknownFPort} threw: ${error.message}`];
  }
}

function validateRejectedFPort(profile, testCase, fPort, label, valueOptions) {
  try {
    const result = testDecode(profile.codec, fPort, testCase.input);
    const rejectedCase = { ...testCase, fPort };
    delete rejectedCase.expectedOutput;
    const errors = validateResult(profile, rejectedCase, result, valueOptions);
    if (Array.isArray(result.data) && result.data.length > 0) {
      errors.push(`${label} fPort ${fPort} produced BACnet data`);
    }
    if (!Array.isArray(result.errors) || result.errors.length === 0) {
      errors.push(`${label} fPort ${fPort} must return an errors array`);
    }
    return errors;
  } catch (error) {
    return [`${label} fPort ${fPort} threw: ${error.message}`];
  }
}

function validateAgnosticFPort(profile, testCase, baseline, valueOptions) {
  const errors = [];
  const alternateFPort = testCase.fPort === 223 ? 1 : 223;
  try {
    const alternate = testDecode(profile.codec, alternateFPort, testCase.input);
    const alternateCase = { ...testCase, fPort: alternateFPort };
    delete alternateCase.expectedOutput;
    errors.push(...validateResult(profile, alternateCase, alternate, valueOptions).map(error => `alternate application fPort ${alternateFPort}: ${error}`));
    if (!deepEqual(alternate.data || [], baseline.data || [])) {
      errors.push(`port-agnostic decoder changed output on application fPort ${alternateFPort}`);
    }
  } catch (error) {
    errors.push(`alternate application fPort ${alternateFPort} threw: ${error.message}`);
  }
  errors.push(...validateRejectedFPort(profile, testCase, 0, 'MAC-command', valueOptions));
  errors.push(...validateRejectedFPort(profile, testCase, 255, 'reserved', valueOptions));
  return errors;
}

function seedFrom(value) {
  let seed = 2166136261;
  for (const character of String(value)) {
    seed ^= character.charCodeAt(0);
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  return seed || 1;
}

function nextRandom(state) {
  let value = state.value;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.value = value >>> 0;
  return state.value / 0x100000000;
}

function validateSeededFuzz(profile, testCase, valueOptions) {
  const errors = [];
  const state = { value: seedFrom(`${testCase.name}:${testCase.input}:${testCase.fPort}`) };
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const length = Math.floor(nextRandom(state) * 256);
    const bytes = [];
    for (let index = 0; index < length; index += 1) bytes.push(Math.floor(nextRandom(state) * 256));
    const input = bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
    try {
      const first = testDecode(profile.codec, testCase.fPort, input);
      const second = testDecode(profile.codec, testCase.fPort, input);
      if (!deepEqual(first, second)) errors.push(`seeded fuzz ${iteration}: decoder output is not deterministic`);
      const fuzzCase = { ...testCase, input };
      delete fuzzCase.expectedOutput;
      errors.push(...validateResult(profile, fuzzCase, first, valueOptions).map(error => `seeded fuzz ${iteration}: ${error}`));
    } catch (error) {
      errors.push(`seeded fuzz ${iteration} threw: ${error.message}`);
    }
  }
  return errors;
}

function validateTestFixture(profilePath, fixturePath) {
  const profile = loadYAML(profilePath);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const errors = [];
  const warnings = [];
  const results = [];
  const failures = [];
  const coveredErrors = new Set();
  const observedChannels = new Set();
  const schemaCheck = validateFixtureSchema(fixture);
  errors.push(...schemaCheck.errors);
  if (!schemaCheck.valid) {
    for (const [index, message] of schemaCheck.errors.entries()) {
      failures.push(validationErrorFailure('candidateStrict.checks.fixture', message, { field: `errors[${index}]` }));
    }
    return { valid: false, errors, warnings, results, failures };
  }
  const robustness = validateStrictFixtureRobustnessDetails(fixture);
  errors.push(...robustness.errors);
  failures.push(...robustness.failures);
  for (const message of robustness.errors) coveredErrors.add(message);
  const valueOptions = {
    requireBinary01: fixture.strict === true,
    requireCanonicalReturn: fixture.strict === true
  };
  const knownFPorts = new Set([
    ...fixture.testCases.map(testCase => testCase.fPort),
    ...((fixture.fPortPolicy && fixture.fPortPolicy.mode === 'fixed' && fixture.fPortPolicy.ports) || [])
  ]);

  const expectedProfile = path.basename(profilePath, path.extname(profilePath));
  if (fixture.profile !== expectedProfile) errors.push(`Fixture profile '${fixture.profile}' must equal '${expectedProfile}'`);
  if (fixture.evidenceLevel === 'known-answer' && !fixture.testCases.some(testCase => Object.prototype.hasOwnProperty.call(testCase, 'expectedOutput'))) {
    errors.push('known-answer fixtures must contain at least one expectedOutput');
  }
  if (fixture.evidenceLevel === 'decoder-derived' && !fixture.testCases.some(testCase => Object.prototype.hasOwnProperty.call(testCase, 'expectedOutput'))) {
    errors.push('decoder-derived fixtures must contain at least one expectedOutput');
  }

  for (const testCase of fixture.testCases) {
    const testErrors = [];
    const testFailures = [];
    try {
      const first = testDecode(profile.codec, testCase.fPort, testCase.input);
      const second = testDecode(profile.codec, testCase.fPort, testCase.input);
      if (!deepEqual(first, second)) testErrors.push('Decoder output is not deterministic');
      testErrors.push(...validateResult(profile, testCase, first, valueOptions, {
        failures: testFailures,
        checkPath: 'candidateStrict.checks.fixture'
      }));
      for (const item of first.data || []) observedChannels.add(item.channel);
      if ((fixture.robustness && fixture.robustness.checkTruncation) !== false) {
        testErrors.push(...validateTruncation(profile, testCase, valueOptions));
      }
      if ((fixture.robustness && fixture.robustness.checkUnknownFPort) !== false) {
        if (fixture.fPortPolicy && fixture.fPortPolicy.mode === 'agnostic') {
          testErrors.push(...validateAgnosticFPort(profile, testCase, first, valueOptions));
        } else if (!fixture.fPortPolicy || fixture.fPortPolicy.mode !== 'ignored') {
          testErrors.push(...validateUnknownFPort(profile, testCase, knownFPorts, valueOptions));
        }
      }
      if (fixture.robustness && fixture.robustness.checkFuzz === true) {
        testErrors.push(...validateSeededFuzz(profile, testCase, valueOptions));
      }
    } catch (error) {
      testErrors.push(error.message);
    }
    const structuredMessages = new Set(testFailures.map(failure => failure.message));
    for (const [index, message] of testErrors.entries()) {
      if (!structuredMessages.has(message)) {
        testFailures.push(validationErrorFailure('candidateStrict.checks.fixture', message, {
          testCase: testCase.name,
          payload: String(testCase.input || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase(),
          fPort: testCase.fPort,
          field: `errors[${index}]`
        }));
      }
    }
    if (testErrors.length > 0) errors.push(...testErrors.map(error => `${testCase.name}: ${error}`));
    failures.push(...testFailures);
    for (const failure of testFailures) coveredErrors.add(`${testCase.name}: ${failure.message}`);
    results.push({ name: testCase.name, valid: testErrors.length === 0, errors: testErrors });
  }

  const outputTypes = new Set(['AnalogOutputObject', 'BinaryOutputObject']);
  const declaredChannels = Object.entries(profile.datatype || {})
    .filter(([, config]) => !outputTypes.has(config.type))
    .map(([channel]) => Number(channel))
    .sort((a, b) => a - b);
  const missingChannels = declaredChannels.filter(channel => !observedChannels.has(channel));
  if (missingChannels.length > 0) {
    const message = `Test fixtures do not cover datatype channels: ${missingChannels.join(', ')}`;
    if (fixture.evidenceLevel === 'documentation-only') warnings.push(message);
    else errors.push(message);
  }
  if (fixture.evidenceLevel === 'documentation-only') warnings.push('No independent known-answer oracle is available');

  for (const [index, message] of errors.entries()) {
    if (!coveredErrors.has(message)) {
      failures.push(validationErrorFailure('candidateStrict.checks.fixture', message, { field: `errors[${index}]` }));
    }
  }

  return { valid: errors.length === 0, errors, warnings, results, failures, observedChannels: [...observedChannels].sort((a, b) => a - b) };
}

function main() {
  const profilePath = process.argv[2];
  const fixturePath = process.argv[3];
  if (!profilePath || !fixturePath) {
    console.error('Usage: node scripts/lib/validation/test-fixture.js <profile.yaml> <profile.test.json> [--json]');
    process.exit(2);
  }
  const report = validateTestFixture(profilePath, fixturePath);
  console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : (report.valid ? 'Profile fixture: PASS' : `Profile fixture: FAIL\n${report.errors.join('\n')}`));
  process.exit(report.valid ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  validateTestFixture,
  validateStrictFixtureRobustness,
  validateStrictFixtureRobustnessDetails
};
