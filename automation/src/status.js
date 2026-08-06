'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, writeText, appendGithubOutput, ensureParent } = require('./io');

function safeMarkdownText(value) {
  return String(value).replace(/\r?\n/g, ' ').replace(/@/g, '@\u200b');
}

function combinedStatus(candidateDir, ciReportPath, extraChecks = {}) {
  const manifest = readJson(path.join(candidateDir, 'manifest.json'));
  let ci;
  try {
    ci = fs.existsSync(ciReportPath) ? readJson(ciReportPath) : null;
  } catch (error) {
    ci = { valid: false, checks: {}, error: `CI report is invalid: ${error.message}` };
  }
  if (!ci) ci = { valid: false, checks: {}, error: 'CI report was not produced' };
  ci.checks = { ...(ci.checks || {}), ...extraChecks };
  if (Object.values(extraChecks).some(check => !check.valid)) ci.valid = false;
  ci.available = ci.valid === true || Boolean(ci.checks && Object.keys(ci.checks).length > 0);
  const reviewPassed = manifest.status === 'candidate' && manifest.review && manifest.review.approved && manifest.adversarial && manifest.adversarial.approved;
  const valid = reviewPassed && ci.valid === true;
  const reviewFindings = [
    ...((manifest.review && manifest.review.findings) || []),
    ...((manifest.adversarial && manifest.adversarial.findings) || [])
  ];
  const ciErrors = Object.entries(ci.checks || {}).flatMap(([name, check]) => (check.errors || []).map(error => `${name}: ${error}`));
  if (ci.error) ciErrors.push(ci.error);
  return {
    eligible: true,
    valid,
    retryable: !valid && manifest.retryable === true,
    manifest,
    ci,
    errors: [...reviewFindings, ...ciErrors, ...(manifest.details || [])]
  };
}

function writeStatusOutputs(status) {
  appendGithubOutput('valid', status.valid ? 'true' : 'false');
  appendGithubOutput('retryable', status.retryable ? 'true' : 'false');
  appendGithubOutput('issue_number', status.manifest.issueNumber);
  appendGithubOutput('profile_path', status.manifest.profilePath || '');
  appendGithubOutput('fixture_path', status.manifest.fixturePath || '');
  appendGithubOutput('attempt', status.manifest.attempt || 1);
}

function failureMarkdown(status) {
  let submitterAction = '';
  if (status.manifest.status === 'evidence-blocked') {
    submitterAction = '\n\nPlease edit the original Issue to correct or add the cited protocol evidence. Do not put the missing facts only in comments.';
  } else if (['OCR_UNSUPPORTED', 'SOURCE_UNAVAILABLE'].includes(status.manifest.code)) {
    submitterAction = '\n\nPlease edit the original Issue and provide an accessible, machine-readable PDF, HTML, or text source. OCR is not supported.';
  }
  return `## Profile Automation validation failed\n\n` +
    `Attempt: ${status.manifest.attempt || 1}/3\n\n` +
    `${status.errors.length > 0 ? status.errors.map(error => `- ${safeMarkdownText(typeof error === 'string' ? error : JSON.stringify(error))}`).join('\n') : '- Candidate did not pass all required reviews.'}` +
    `${submitterAction}\n`;
}

function preparePublish(candidateDir, workspaceRoot) {
  const manifest = readJson(path.join(candidateDir, 'manifest.json'));
  if (!manifest.profilePath || !manifest.fixturePath) throw new Error('Candidate does not contain publishable files');
  for (const relativePath of [manifest.profilePath, manifest.fixturePath]) {
    const source = path.join(candidateDir, relativePath);
    const destination = path.join(workspaceRoot, relativePath);
    if (fs.existsSync(destination)) {
      throw new Error(`Refusing to overwrite an existing repository file: ${relativePath}`);
    }
    ensureParent(destination);
    fs.copyFileSync(source, destination);
  }
  const review = fs.readFileSync(path.join(candidateDir, 'review.md'), 'utf8');
  const prBodyPath = path.join(workspaceRoot, 'automation', '.work', 'pr-body.md');
  writeText(prBodyPath, `${review}\n\nCloses #${manifest.issueNumber}\n`);
  appendGithubOutput('branch', `auto-profile-${manifest.issueNumber}`);
  appendGithubOutput('title', `Add: BACnet profile from issue #${manifest.issueNumber}`);
  appendGithubOutput('body_path', prBodyPath);
  appendGithubOutput('issue_number', manifest.issueNumber);
  appendGithubOutput('profile_path', manifest.profilePath);
  appendGithubOutput('fixture_path', manifest.fixturePath);
  return { manifest, prBodyPath };
}

module.exports = { combinedStatus, writeStatusOutputs, failureMarkdown, preparePublish };
