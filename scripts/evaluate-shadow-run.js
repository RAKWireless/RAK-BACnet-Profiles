#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../automation/src/io');

const MINIMUM_ROLLOUT_SAMPLE_SIZE = 10;

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

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort((left, right) => left - right);
}

function parseExpectedIssueNumbers(value) {
  const numbers = JSON.parse(String(value || '[]'));
  if (!Array.isArray(numbers) || numbers.length === 0 || numbers.some(number => !Number.isInteger(number) || number <= 0)) {
    throw new Error('Expected Issues must be a non-empty JSON array of positive integers');
  }
  if (duplicateValues(numbers).length > 0) throw new Error('Expected Issues must not contain duplicates');
  return numbers;
}

function evaluate(reports, target = 0.85, options = {}) {
  const expectedIssueNumbers = options.expectedIssueNumbers || [];
  const enforceRolloutGate = options.enforceRolloutGate === true;
  const minimumSampleSize = Number(options.minimumSampleSize || MINIMUM_ROLLOUT_SAMPLE_SIZE);
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
  const reportIssueNumbers = reports.map(report => Number(report.issueNumber)).filter(Number.isInteger);
  const expectedSet = new Set(expectedIssueNumbers);
  const reportSet = new Set(reportIssueNumbers);
  const missingIssueNumbers = expectedIssueNumbers.filter(issueNumber => !reportSet.has(issueNumber));
  const unexpectedIssueNumbers = expectedIssueNumbers.length === 0
    ? []
    : reportIssueNumbers.filter(issueNumber => !expectedSet.has(issueNumber));
  const duplicateIssueNumbers = duplicateValues(reportIssueNumbers);
  const complete = expectedIssueNumbers.length === 0 || (
    reports.length === expectedIssueNumbers.length &&
    missingIssueNumbers.length === 0 &&
    unexpectedIssueNumbers.length === 0 &&
    duplicateIssueNumbers.length === 0
  );
  const sampleSizeSufficient = eligible.length >= minimumSampleSize;
  return {
    valid: complete && eligible.length > 0 && rate >= target && (!enforceRolloutGate || sampleSizeSufficient),
    mode: enforceRolloutGate ? 'rollout' : 'smoke',
    complete,
    target,
    minimumSampleSize,
    sampleSizeSufficient,
    expectedIssues: expectedIssueNumbers.length,
    totalIssues: reports.length,
    eligibleIssues: eligible.length,
    evidenceBlockedIssues: evidenceBlocked.length,
    publishableCandidateIssues: publishableCandidates.length,
    successfulIssues: successful.length,
    missingIssueNumbers,
    unexpectedIssueNumbers,
    duplicateIssueNumbers,
    evidencePassRate,
    candidateSuccessRate,
    automaticSuccessRate: rate
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const directory = args._[0];
  if (!directory) {
    console.error('Usage: node scripts/evaluate-shadow-run.js <shadow-results-directory> --expected-issues "[31]" [--enforce-rollout-gate true] [--json]');
    process.exit(2);
  }
  let expectedIssueNumbers;
  try {
    expectedIssueNumbers = parseExpectedIssueNumbers(args['expected-issues']);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const result = evaluate(findReports(directory), 0.85, {
    expectedIssueNumbers,
    enforceRolloutGate: String(args['enforce-rollout-gate'] || 'false').toLowerCase() === 'true'
  });
  console.log(args.json ? JSON.stringify(result, null, 2) : [
    `Mode: ${result.mode}`,
    `Expected issues: ${result.expectedIssues}`,
    `Shadow issues: ${result.totalIssues}`,
    `Results complete: ${result.complete ? 'yes' : 'no'}`,
    `Missing issues: ${result.missingIssueNumbers.join(', ') || 'none'}`,
    `Unexpected issues: ${result.unexpectedIssueNumbers.join(', ') || 'none'}`,
    `Duplicate issues: ${result.duplicateIssueNumbers.join(', ') || 'none'}`,
    `Eligible: ${result.eligibleIssues}`,
    `Evidence blocked: ${result.evidenceBlockedIssues}`,
    `Publishable candidates: ${result.publishableCandidateIssues}`,
    `Successful: ${result.successfulIssues}`,
    `Evidence pass rate: ${(result.evidencePassRate * 100).toFixed(1)}%`,
    `Candidate success rate: ${(result.candidateSuccessRate * 100).toFixed(1)}%`,
    `Automatic success rate: ${(result.automaticSuccessRate * 100).toFixed(1)}%`,
    `Target: ${(result.target * 100).toFixed(1)}%`,
    `Sample size sufficient (>=${result.minimumSampleSize} eligible): ${result.sampleSizeSufficient ? 'yes' : 'no'}`
  ].join('\n'));
  process.exit(result.valid ? 0 : 1);
}

if (require.main === module) main();

module.exports = { findReports, evaluate, parseExpectedIssueNumbers, MINIMUM_ROLLOUT_SAMPLE_SIZE };
