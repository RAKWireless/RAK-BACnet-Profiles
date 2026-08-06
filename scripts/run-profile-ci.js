#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  validateYAMLSyntax,
  validateSchema,
  validateCodecSyntax,
  validateFileNaming
} = require('./validate-profile');
const { loadYAML, validateRequiredFields, validateBACnetObjects } = require('./lib/yaml-parser');
const { analyzeCodecSafety } = require('./lib/validation/codec-safety');
const { validateProfileSemantics } = require('./lib/validation/profile-semantics');
const { validateTestFixture } = require('./lib/validation/test-fixture');

function defaultFixturePath(profilePath) {
  const basename = path.basename(profilePath, path.extname(profilePath));
  return path.join(path.dirname(profilePath), 'tests', `${basename}.test.json`);
}

function runGeneratedProfileCI(profilePath, fixturePath = defaultFixturePath(profilePath)) {
  const report = { profile: profilePath, fixture: fixturePath, valid: true, checks: {} };
  const yamlCheck = validateYAMLSyntax(profilePath);
  report.checks.yaml = yamlCheck;
  if (!yamlCheck.valid) return { ...report, valid: false };

  const profile = loadYAML(profilePath);
  report.checks.schema = validateSchema(profile);
  report.checks.requiredFields = validateRequiredFields(profile);
  report.checks.codecSafety = analyzeCodecSafety(profile.codec);
  report.checks.codecSyntax = report.checks.codecSafety.valid
    ? validateCodecSyntax(profile.codec)
    : { valid: false, errors: ['Codec execution was skipped because the static safety check failed'], warnings: [] };
  report.checks.bacnet = validateBACnetObjects(profile);
  report.checks.naming = validateFileNaming(profilePath);
  report.checks.semantics = validateProfileSemantics(profile, profilePath, { strict: true });
  const executable = report.checks.codecSafety.valid && report.checks.codecSyntax.valid;
  report.checks.fixture = !executable
    ? { valid: false, errors: ['Fixture execution was skipped because the codec did not pass static validation'], warnings: [] }
    : (fs.existsSync(fixturePath)
      ? validateTestFixture(profilePath, fixturePath)
      : { valid: false, errors: [`Missing committed test fixture: ${fixturePath}`], warnings: [] });

  report.valid = Object.values(report.checks).every(check => check.valid);
  return report;
}

function main() {
  const args = process.argv.slice(2);
  const profilePath = args.find(arg => !arg.startsWith('--'));
  const fixtureIndex = args.indexOf('--fixture');
  const fixturePath = fixtureIndex >= 0 ? args[fixtureIndex + 1] : undefined;
  if (!profilePath) {
    console.error('Usage: node scripts/run-profile-ci.js <profile.yaml> [--fixture path] [--json]');
    process.exit(2);
  }
  const report = runGeneratedProfileCI(profilePath, fixturePath);
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const [name, check] of Object.entries(report.checks)) {
      console.log(`${check.valid ? 'PASS' : 'FAIL'} ${name}`);
      for (const error of check.errors || []) console.log(`  - ${error}`);
      for (const warning of check.warnings || []) console.log(`  ! ${warning}`);
    }
  }
  process.exit(report.valid ? 0 : 1);
}

if (require.main === module) main();

module.exports = { runGeneratedProfileCI, defaultFixturePath };
