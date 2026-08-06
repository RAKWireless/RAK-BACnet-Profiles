#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function findReports(directory) {
  const reports = [];
  if (!fs.existsSync(directory)) return reports;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) reports.push(...findReports(fullPath));
    if (entry.isFile() && ['combined.json', 'shadow-result.json'].includes(entry.name)) {
      try {
        reports.push(JSON.parse(fs.readFileSync(fullPath, 'utf8')));
      } catch (error) {
        reports.push({ eligible: false, valid: false, error: error.message, file: fullPath });
      }
    }
  }
  return reports;
}

function evaluate(reports, target = 0.85) {
  const eligible = reports.filter(report => report.eligible === true || report.manifest);
  const successful = eligible.filter(report => report.valid === true);
  const rate = eligible.length === 0 ? 0 : successful.length / eligible.length;
  return {
    valid: eligible.length > 0 && rate >= target,
    target,
    totalIssues: reports.length,
    eligibleIssues: eligible.length,
    successfulIssues: successful.length,
    automaticSuccessRate: rate
  };
}

function main() {
  const directory = process.argv[2];
  if (!directory) {
    console.error('Usage: node scripts/evaluate-shadow-run.js <shadow-results-directory> [--json]');
    process.exit(2);
  }
  const result = evaluate(findReports(directory));
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : [
    `Shadow issues: ${result.totalIssues}`,
    `Eligible: ${result.eligibleIssues}`,
    `Successful: ${result.successfulIssues}`,
    `Automatic success rate: ${(result.automaticSuccessRate * 100).toFixed(1)}%`,
    `Target: ${(result.target * 100).toFixed(1)}%`
  ].join('\n'));
  process.exit(result.valid ? 0 : 1);
}

if (require.main === module) main();

module.exports = { findReports, evaluate };
