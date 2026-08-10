#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { validateTestFixture } = require('./lib/validation/test-fixture');
const { runGeneratedProfileCI } = require('./run-profile-ci');

const ROOT = path.resolve(__dirname, '..');

function findFixtures(directory) {
  const results = [];
  if (!fs.existsSync(directory)) return results;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...findFixtures(fullPath));
    if (entry.isFile() && entry.name.endsWith('.test.json')) results.push(fullPath);
  }
  return results;
}

function main() {
  const fixtures = findFixtures(path.join(ROOT, 'profiles'));
  const reports = [];
  for (const fixture of fixtures) {
    const profileName = path.basename(fixture, '.test.json');
    const vendorDir = path.dirname(path.dirname(fixture));
    const profilePath = path.join(vendorDir, `${profileName}.yaml`);
    let strict = false;
    try {
      strict = JSON.parse(fs.readFileSync(fixture, 'utf8')).strict === true;
    } catch {
      strict = false;
    }
    const fixtureReport = fs.existsSync(profilePath)
      ? (strict ? runGeneratedProfileCI(profilePath, fixture) : validateTestFixture(profilePath, fixture))
      : { valid: false, errors: [`Missing profile for committed fixture: ${profilePath}`], warnings: [] };
    reports.push({ profile: profilePath, fixture, strict, ...fixtureReport });
  }
  const valid = reports.every(report => report.valid);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ valid, reports }, null, 2));
  else {
    console.log(`Committed fixtures: ${reports.length}`);
    for (const report of reports) console.log(`${report.valid ? 'PASS' : 'FAIL'} ${report.profile}`);
  }
  process.exit(valid ? 0 : 1);
}

if (require.main === module) main();
