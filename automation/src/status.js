'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeText, appendGithubOutput } = require('./io');

function safeMarkdown(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/@/g, '@\u200b');
}

function intakeComment(intake, decision) {
  if (decision.state === 'queued') {
    const warnings = (intake.warnings || []).map(item => `- ${safeMarkdown(item)}`).join('\n');
    const paused = decision.paused
      ? '\n\nProfile Agent execution is currently disabled by the repository kill switch; Intake remains active and this request will stay queued.'
      : '\n\nA new run is bound to the current Issue body SHA. Editing the Issue cancels and replaces that run.';
    return `The request passed the uplink-only Intake gate and is queued for Profile Agent generation.${warnings ? `\n\nDeferred evidence checks:\n\n${warnings}` : ''}${paused}`;
  }
  if (decision.state === 'awaiting-approval') {
    const warnings = (intake.warnings || []).map(item => `- ${safeMarkdown(item)}`).join('\n');
    return `The request passed the content gate, but it was opened by an external contributor. A maintainer must review the current Issue body and add \`profile:approved\`. Editing the Issue invalidates that approval.${warnings ? `\n\nCurrent rollout notes:\n\n${warnings}` : ''}`;
  }
  if (decision.state === 'manual') {
    const manualReasons = intake.manualReasons || [];
    const diagnostics = [...(intake.errors || []), ...(intake.warnings || [])];
    if (manualReasons.length === 0) {
      return `This request is outside the first Profile Automation scope and requires manual handling.\n\n${diagnostics.map(item => `- ${safeMarkdown(item)}`).join('\n')}`;
    }
    const reasons = manualReasons.map(item => `- ${safeMarkdown(item)}`).join('\n');
    const additional = diagnostics.length > 0
      ? `\n\nAdditional Intake diagnostics (these do not change the manual routing):\n\n${diagnostics.map(item => `- ${safeMarkdown(item)}`).join('\n')}`
      : '';
    return `This request is outside the first Profile Automation scope and requires manual handling.\n\nManual scope reasons:\n\n${reasons}${additional}`;
  }
  return `Please edit the original Issue to resolve these items; answers added only in comments are not used.\n\n${(intake.errors || []).map(item => `- ${safeMarkdown(item)}`).join('\n')}`;
}

function reportErrors(report) {
  if (!report) return ['Validation report was not produced'];
  const errors = [];
  for (const [name, check] of Object.entries(report.checks || {})) {
    for (const error of check.errors || []) errors.push(`${name}: ${error}`);
  }
  for (const error of report.errors || []) errors.push(error);
  if (report.error) errors.push(report.error);
  return errors;
}

function failureMarkdown(manifest, report, attempt = 1) {
  const errors = reportErrors(report);
  return `## Profile Automation stopped\n\nAttempt: ${attempt}/2\n\n${errors.map(error => `- ${safeMarkdown(error)}`).join('\n') || '- Candidate did not pass clean validation.'}\n`;
}

function syncFailureMessage(outputPath, manifest, report, attempt = 1) {
  const target = path.resolve(outputPath);
  if (report && report.valid === true) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return false;
  }
  writeText(target, failureMarkdown(manifest, report, attempt));
  return true;
}

function evidenceTable(rows) {
  const body = (rows || []).map(row => (
    `| ${safeMarkdown(row.field)} | ${safeMarkdown(row.officialDocument || '—')} | ${safeMarkdown(row.decoder || '—')} | ${safeMarkdown(row.knownPayload || '—')} | ${safeMarkdown(row.resolution)} | ${safeMarkdown(row.resolvedValue)} | ${safeMarkdown(row.rationale)} |`
  ));
  return `| Field | Official document | Decoder | Known payload | Resolution | Value | Rationale |\n|---|---|---|---|---|---|---|\n${body.length ? body.join('\n') : '| — | — | — | — | — | — | No rows returned |'}`;
}

function automationMeta(body) {
  const match = String(body || '').match(/<!-- profile-automation:meta (\{[^\n]+\}) -->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function preparePublish(candidateDirectory, validationReportPath, options = {}) {
  const directory = path.resolve(candidateDirectory);
  const manifest = readJson(path.join(directory, 'manifest.json'));
  const result = readJson(path.join(directory, 'agent-result.json'));
  const report = readJson(validationReportPath);
  if (manifest.status !== 'candidate' || report.valid !== true) throw new Error('Only a clean-validated candidate can be published');
  const reviewCycle = Number(options.reviewCycle || 0);
  const meta = {
    schemaVersion: 1,
    issueNumber: manifest.issueNumber,
    issueBodySha: manifest.issueBodySha,
    provider: options.provider,
    model: options.model,
    reviewCycle
  };
  const warnings = result.warnings && result.warnings.length
    ? result.warnings.map(item => `- ${safeMarkdown(item)}`).join('\n')
    : '- None.';
  const body = `<!-- profile-automation:meta ${JSON.stringify(meta)} -->\n` +
    `## Automated Profile evidence\n\n` +
    `- Issue: #${manifest.issueNumber}\n` +
    `- Issue body SHA: \`${manifest.issueBodySha}\`\n` +
    `- Provider/model: \`${safeMarkdown(options.provider)} / ${safeMarkdown(options.model)}\`\n` +
    `- Evidence level: **${safeMarkdown(result.evidenceLevel)}**\n` +
    `- fPort policy: \`${safeMarkdown(JSON.stringify(result.fPortPolicy))}\`\n` +
    `- Clean validation: **passed**\n` +
    `- Hardware verified: **no**\n\n` +
    `### Evidence matrix\n\n${evidenceTable(result.evidenceMatrix)}\n\n` +
    `### Agent summary\n\n${safeMarkdown(result.summary)}\n\n` +
    `### Warnings\n\n${warnings}\n\n` +
    `> The automation will never mark this PR ready, approve it, or merge it.\n\n` +
    `Closes #${manifest.issueNumber}\n`;
  const prBodyPath = path.join(directory, 'pr-body.md');
  writeText(prBodyPath, body);
  appendGithubOutput('branch', `auto-profile-${manifest.issueNumber}`);
  appendGithubOutput('title', `Add: ${path.basename(manifest.profilePath, '.yaml')} BACnet profile`);
  appendGithubOutput('body_path', prBodyPath);
  appendGithubOutput('issue_number', manifest.issueNumber);
  appendGithubOutput('profile_path', manifest.profilePath);
  appendGithubOutput('fixture_path', manifest.fixturePath);
  return { manifest, result, report, prBodyPath, meta };
}

module.exports = {
  safeMarkdown,
  intakeComment,
  failureMarkdown,
  syncFailureMessage,
  reportErrors,
  evidenceTable,
  automationMeta,
  preparePublish
};
