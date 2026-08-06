#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const { loadYAML } = require('../yaml-parser');
const { hexToBytes } = require('../hex-converter');
const { testDecode } = require('../../test-codec');
const { validateDecodedData } = require('./profile-semantics');

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

function validateResult(profile, testCase, result) {
  const errors = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) return ['decodeUplink must return an object'];
  if (result.data !== undefined && !Array.isArray(result.data)) errors.push('decodeUplink.data must be an array when present');
  const semantic = validateDecodedData(profile, result.data || []);
  errors.push(...semantic.errors);
  if (Object.prototype.hasOwnProperty.call(testCase, 'expectedOutput') && !deepEqual(result.data || [], testCase.expectedOutput)) {
    errors.push('Actual output does not match expectedOutput');
  }
  return errors;
}

function validateTruncation(profile, testCase) {
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
      errors.push(...validateResult(profile, truncatedCase, result).map(error => `truncated length ${length}: ${error}`));
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

function validateUnknownFPort(profile, testCase, knownFPorts) {
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
    const errors = validateResult(profile, unknownCase, result);
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

function validateTestFixture(profilePath, fixturePath) {
  const profile = loadYAML(profilePath);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const errors = [];
  const warnings = [];
  const results = [];
  const observedChannels = new Set();
  const schemaCheck = validateFixtureSchema(fixture);
  errors.push(...schemaCheck.errors);
  if (!schemaCheck.valid) return { valid: false, errors, warnings, results };
  const knownFPorts = new Set(fixture.testCases.map(testCase => testCase.fPort));

  const expectedProfile = path.basename(profilePath, path.extname(profilePath));
  if (fixture.profile !== expectedProfile) errors.push(`Fixture profile '${fixture.profile}' must equal '${expectedProfile}'`);
  if (fixture.evidenceLevel === 'known-answer' && !fixture.testCases.some(testCase => Object.prototype.hasOwnProperty.call(testCase, 'expectedOutput'))) {
    errors.push('known-answer fixtures must contain at least one expectedOutput');
  }

  for (const testCase of fixture.testCases) {
    const testErrors = [];
    try {
      const first = testDecode(profile.codec, testCase.fPort, testCase.input);
      const second = testDecode(profile.codec, testCase.fPort, testCase.input);
      if (!deepEqual(first, second)) testErrors.push('Decoder output is not deterministic');
      testErrors.push(...validateResult(profile, testCase, first));
      for (const item of first.data || []) observedChannels.add(item.channel);
      if ((fixture.robustness && fixture.robustness.checkTruncation) !== false) {
        testErrors.push(...validateTruncation(profile, testCase));
      }
      if ((fixture.robustness && fixture.robustness.checkUnknownFPort) !== false) {
        testErrors.push(...validateUnknownFPort(profile, testCase, knownFPorts));
      }
    } catch (error) {
      testErrors.push(error.message);
    }
    if (testErrors.length > 0) errors.push(...testErrors.map(error => `${testCase.name}: ${error}`));
    results.push({ name: testCase.name, valid: testErrors.length === 0, errors: testErrors });
  }

  const declaredChannels = Object.keys(profile.datatype || {}).map(Number).sort((a, b) => a - b);
  const missingChannels = declaredChannels.filter(channel => !observedChannels.has(channel));
  if (missingChannels.length > 0) errors.push(`Test fixtures do not cover datatype channels: ${missingChannels.join(', ')}`);
  if (fixture.evidenceLevel === 'documentation-only') warnings.push('No independent known-answer oracle is available');

  return { valid: errors.length === 0, errors, warnings, results, observedChannels: [...observedChannels].sort((a, b) => a - b) };
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

module.exports = { validateTestFixture };
