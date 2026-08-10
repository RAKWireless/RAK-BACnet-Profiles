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
  const evidencePassed = eligible.filter(report => {
    if (typeof report.evidencePassed === 'boolean') return report.evidencePassed;
    const manifest = report.manifest || {};
    return Boolean(manifest.profilePath && manifest.fixturePath) ||
      ['generation', 'repair', 'normalization', 'review'].includes(manifest.stage) ||
      ['candidate', 'review-failed'].includes(manifest.status);
  });
  const evidenceBlocked = eligible.filter(report => !evidencePassed.includes(report));
  const publishableCandidates = eligible.filter(report => report.candidateProduced === true || (report.manifest && report.manifest.profilePath && report.manifest.fixturePath));
  const rate = eligible.length === 0 ? 0 : successful.length / eligible.length;
  const evidencePassRate = eligible.length === 0 ? 0 : evidencePassed.length / eligible.length;
  const candidateSuccessRate = publishableCandidates.length === 0 ? 0 : successful.length / publishableCandidates.length;
  return {
    valid: eligible.length > 0 && rate >= target,
    target,
    sampleSizeSufficient: eligible.length >= 5,
    totalIssues: reports.length,
    eligibleIssues: eligible.length,
    evidenceBlockedIssues: evidenceBlocked.length,
    publishableCandidateIssues: publishableCandidates.length,
    successfulIssues: successful.length,
    evidencePassRate,
    candidateSuccessRate,
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
    `Evidence blocked: ${result.evidenceBlockedIssues}`,
    `Publishable candidates: ${result.publishableCandidateIssues}`,
    `Successful: ${result.successfulIssues}`,
    `Evidence pass rate: ${(result.evidencePassRate * 100).toFixed(1)}%`,
    `Candidate success rate: ${(result.candidateSuccessRate * 100).toFixed(1)}%`,
    `Automatic success rate: ${(result.automaticSuccessRate * 100).toFixed(1)}%`,
    `Target: ${(result.target * 100).toFixed(1)}%`,
    `Sample size sufficient (>=5 eligible): ${result.sampleSizeSufficient ? 'yes' : 'no'}`
  ].join('\n'));
  process.exit(result.valid ? 0 : 1);
}

if (require.main === module) main();

module.exports = { findReports, evaluate };
