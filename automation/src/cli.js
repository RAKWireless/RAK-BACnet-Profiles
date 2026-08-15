#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseIssue } = require('./issue-parser');
const { loadOfficialSource, decoderFallbackSource } = require('./source-loader');
const { loadDecoder } = require('./decoder-loader');
const { GitHubClient } = require('./github-client');
const { decideIntake } = require('./intake-policy');
const { providerCatalog, resolveProvider, resolveAgentRuntime, MAX_ATTEMPTS, MAX_REVIEW_CYCLES } = require('./config');
const {
  prepareAgentInput,
  captureAgentOutput,
  applyCandidatePatch,
  seedPreviousFromCandidate,
  seedPreviousFromRef,
  removeShadowTargets
} = require('./agent-artifact');
const { parseArgs, readJson, writeJson, writeText, appendGithubOutput } = require('./io');
const { assertCollectionIssueSha } = require('./issue-sha');
const { intakeComment, syncFailureMessage, automationMeta, preparePublish } = require('./status');
const { readAgentEvidence } = require('./agent-evidence');

function githubClient() {
  return new GitHubClient(process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN);
}

function serializeError(error) {
  return { message: error && error.message ? error.message : String(error), code: error && error.code ? error.code : null };
}

function enabled() {
  return String(process.env.PROFILE_AGENT_ENABLED || 'true').toLowerCase() !== 'false';
}

function eventFrom(args) {
  return readJson(args.event || process.env.GITHUB_EVENT_PATH);
}

function writeIntakeOutputs(envelope) {
  appendGithubOutput('status', envelope.decision.state);
  appendGithubOutput('should_run', envelope.decision.shouldRun ? 'true' : 'false');
  appendGithubOutput('issue_number', envelope.intake.issueNumber || '');
  appendGithubOutput('issue_body_sha', envelope.intake.issueBodySha || '');
  appendGithubOutput('provider', envelope.agent.provider);
  appendGithubOutput('environment', envelope.agent.environment);
  appendGithubOutput('model', envelope.agent.model || '');
  appendGithubOutput('effort', envelope.agent.effort || '');
}

async function commandIntake(args) {
  const event = eventFrom(args);
  const issue = event.issue || event;
  const intake = parseIssue(issue);
  let agent;
  try {
    agent = resolveProvider(issue.labels || [], {
      provider: args.provider,
      model: args.model,
      effort: args.effort
    });
  } catch (error) {
    intake.status = 'needs-info';
    intake.errors = [...(intake.errors || []), error.message];
    agent = resolveProvider([], { provider: 'deepseek' });
  }
  let decision = decideIntake(intake, issue, event, enabled());
  if (decision.state === 'queued' && decision.trust === 'external') {
    const externalEnabled = String(process.env.PROFILE_EXTERNAL_APPROVAL_ENABLED || 'false').toLowerCase() === 'true';
    const approver = event.sender && event.sender.login;
    const permission = approver && process.env.GITHUB_TOKEN
      ? await githubClient().collaboratorPermission(approver)
      : 'none';
    if (!externalEnabled) {
      decision = { state: 'awaiting-approval', shouldRun: false, trust: 'external', consumeApproval: true };
      intake.warnings = [...(intake.warnings || []), 'External Profile Agent approvals are not enabled during the current rollout phase'];
    } else if (!['admin', 'maintain', 'write'].includes(permission)) {
      decision = { state: 'awaiting-approval', shouldRun: false, trust: 'external', consumeApproval: true };
      intake.warnings = [...(intake.warnings || []), 'The approval label was not added by a write/maintain/admin collaborator'];
    }
  }
  const envelope = { schemaVersion: 1, intake, decision, agent };
  if (args.output) writeJson(args.output, envelope);
  writeIntakeOutputs(envelope);
  console.log(JSON.stringify({
    issueNumber: intake.issueNumber,
    issueBodySha: intake.issueBodySha,
    intakeStatus: intake.status,
    decision,
    provider: agent.provider,
    model: agent.model || '(environment configured)'
  }, null, 2));
}

async function commandFetchIntake(args) {
  const issue = await githubClient().getIssue(Number(args['issue-number']));
  const intake = parseIssue(issue, { allowExisting: args['allow-existing'] === true });
  const agent = resolveProvider(issue.labels || [], { provider: args.provider, model: args.model, effort: args.effort });
  const decision = intake.status === 'ready'
    ? { state: 'queued', shouldRun: enabled(), paused: !enabled(), trust: 'manual-dispatch', consumeApproval: true }
    : decideIntake(intake, issue, { action: 'workflow_dispatch' }, enabled());
  const envelope = { schemaVersion: 1, intake, decision, agent };
  if (args.output) writeJson(args.output, envelope);
  writeIntakeOutputs(envelope);
  console.log(JSON.stringify({ issueNumber: intake.issueNumber, issueBodySha: intake.issueBodySha, status: decision.state, provider: agent.provider }, null, 2));
}

async function commandApplyIntake(args) {
  const envelope = readJson(args.intake);
  const { intake, decision } = envelope;
  if (decision.state === 'ignored') return;
  const client = githubClient();
  const label = {
    'awaiting-approval': 'profile:awaiting-approval',
    queued: 'profile:queued',
    'needs-info': 'profile:needs-info',
    manual: 'profile:manual'
  }[decision.state] || 'profile:needs-info';
  await client.addLabels(intake.issueNumber, ['profile-request', 'requirement-gathering']);
  await client.ensureLabel('profile:approved');
  await client.ensureLabel('profile:provider:openai');
  await client.ensureLabel('profile:provider:deepseek');
  await client.setStateLabels(intake.issueNumber, label);
  if (decision.consumeApproval) await client.removeLabel(intake.issueNumber, 'profile:approved');
  const cancelled = await client.cancelIssueRuns(intake.issueNumber, process.env.GITHUB_RUN_ID);
  await client.upsertComment(intake.issueNumber, '<!-- profile-automation:intake -->', intakeComment(intake, decision));
  console.log(JSON.stringify({ issueNumber: intake.issueNumber, state: decision.state, cancelledRuns: cancelled }, null, 2));
}

async function commandCollectSource(args) {
  const issueNumber = Number(args['issue-number']);
  const issue = await githubClient().getIssue(issueNumber);
  const intake = parseIssue(issue, { allowExisting: args['allow-existing'] === true });
  let source = null;
  let decoder = null;
  let decoderError = null;
  let error = null;
  try {
    assertCollectionIssueSha(intake.issueBodySha, args['expected-sha']);
    if (intake.status !== 'ready') {
      const intakeError = new Error(`Issue is not ready for generation: ${intake.status}: ${(intake.errors || []).join('; ')}`);
      intakeError.code = 'INTAKE_NOT_READY';
      throw intakeError;
    }
    const [sourceResult, decoderResult] = await Promise.allSettled([
      loadOfficialSource(intake),
      loadDecoder(intake, { token: process.env.GITHUB_TOKEN })
    ]);
    if (decoderResult.status === 'fulfilled') decoder = decoderResult.value;
    else decoderError = serializeError(decoderResult.reason);
    if (sourceResult.status === 'fulfilled') source = sourceResult.value;
    else if (decoder) source = decoderFallbackSource(intake, decoder);
    else {
      const sourceError = sourceResult.reason;
      if (!sourceError.code) sourceError.code = 'SOURCE_UNAVAILABLE';
      throw sourceError;
    }
  } catch (caught) {
    error = serializeError(caught);
  }
  const bundle = { schemaVersion: 1, intake, source, decoder, decoderError, error };
  writeJson(args.output, bundle);
  appendGithubOutput('ready', !error && intake.status === 'ready' ? 'true' : 'false');
  appendGithubOutput('issue_body_sha', intake.issueBodySha || '');
  appendGithubOutput('error_code', error && error.code ? error.code : '');
  console.log(JSON.stringify({
    issueNumber,
    issueBodySha: intake.issueBodySha,
    ready: !error && intake.status === 'ready',
    source: source && { type: source.type, pages: source.pages, sha256: source.sha256, textLength: String(source.text || '').length },
    decoder: decoder && { origin: decoder.origin, authority: decoder.authority, sha256: decoder.sha256, textLength: String(decoder.text || '').length },
    decoderError,
    error
  }, null, 2));
}

async function commandPrepareAgentInput(args) {
  const request = prepareAgentInput(args.bundle, args.output, {
    mode: args.mode,
    attempt: args.attempt,
    reviewCycle: args['review-cycle'],
    feedback: process.env.PROFILE_REVIEW_FEEDBACK || ''
  });
  appendGithubOutput('profile_path', request.execution.profilePath);
  appendGithubOutput('fixture_path', request.execution.fixturePath);
  console.log(JSON.stringify({ issueNumber: request.issue.number, issueBodySha: request.issue.bodySha, mode: request.execution.mode }, null, 2));
}

async function commandResolveRuntime(args) {
  const runtime = resolveAgentRuntime(String(args.provider), {
    model: args.model,
    effort: args.effort,
    responsesEndpoint: args.endpoint
  });
  appendGithubOutput('model', runtime.model);
  appendGithubOutput('effort', runtime.effort);
  appendGithubOutput('responses_endpoint', runtime.responsesEndpoint);
  appendGithubOutput('environment', runtime.environment);
  console.log(JSON.stringify({ provider: runtime.provider, model: runtime.model, effort: runtime.effort, environment: runtime.environment }, null, 2));
}

async function commandPrepareAdvisoryInput(args) {
  const event = eventFrom(args);
  const pull = event.pull_request || {};
  const value = {
    schemaVersion: 1,
    pullRequestNumber: pull.number || event.number,
    baseSha: pull.base && pull.base.sha,
    headSha: pull.head && pull.head.sha,
    body: String(pull.body || '')
  };
  writeJson(args.output, value);
  console.log(JSON.stringify({ pullRequestNumber: value.pullRequestNumber, prepared: true }, null, 2));
}

async function commandPrepareCodexHome(args) {
  const provider = String(args.provider || '');
  if (!Object.prototype.hasOwnProperty.call(providerCatalog(), provider)) throw new Error(`Unsupported provider: ${provider}`);
  const output = path.resolve(args.output);
  fs.mkdirSync(output, { recursive: true });
  const template = path.join(__dirname, '..', '..', '.github', 'codex', 'config.toml');
  let config = fs.readFileSync(template, 'utf8');
  const catalogText = String(process.env.PROFILE_AGENT_MODEL_CATALOG_JSON || '').trim();
  if (catalogText) {
    const catalog = JSON.parse(catalogText);
    const catalogPath = path.join(output, 'models.json');
    writeJson(catalogPath, catalog);
    config = `model_catalog_json = ${JSON.stringify(catalogPath)}\n${config}`;
  }
  writeText(path.join(output, 'config.toml'), config);
  console.log(JSON.stringify({ provider, codexHomePrepared: true, customModelCatalog: Boolean(catalogText) }, null, 2));
}

async function commandReadAgentEvidence(args) {
  const result = readAgentEvidence(args.request, {
    source: args.source,
    index: args.index === true,
    page: args.page,
    search: args.search,
    lines: args.lines,
    context: args.context
  });
  console.log(JSON.stringify(result, null, 2));
}

async function commandSeedPrevious(args) {
  let result;
  if (args.candidate) result = seedPreviousFromCandidate(args.candidate, args.request, args.report);
  else if (args.ref) {
    seedPreviousFromRef(args.ref, args.request);
    result = { status: 'candidate', candidateSeeded: true };
  }
  else throw new Error('seed-previous requires --candidate or --ref');
  console.log(JSON.stringify({ seeded: true, ...result }, null, 2));
}

async function commandRemoveShadowTargets(args) {
  removeShadowTargets(args.request);
  console.log(JSON.stringify({ removed: true }, null, 2));
}

async function commandCaptureAgentOutput(args) {
  const manifest = captureAgentOutput(args.result, args.request, args.output);
  appendGithubOutput('status', manifest.status);
  appendGithubOutput('retryable', manifest.retryable ? 'true' : 'false');
  appendGithubOutput('issue_number', manifest.issueNumber || '');
  appendGithubOutput('issue_body_sha', manifest.issueBodySha || '');
  appendGithubOutput('profile_path', manifest.profilePath || '');
  appendGithubOutput('fixture_path', manifest.fixturePath || '');
  console.log(JSON.stringify(manifest, null, 2));
}

async function commandRecordCaptureFailure(args) {
  const request = readJson(args.request);
  const manifest = {
    schemaVersion: 1,
    status: 'invalid-agent-output',
    issueNumber: request.issue.number,
    issueBodySha: request.issue.bodySha,
    retryable: true,
    reason: 'Agent output or changed paths violated the capture contract'
  };
  writeJson(path.join(path.resolve(args.output), 'manifest.json'), manifest);
  appendGithubOutput('status', manifest.status);
  appendGithubOutput('retryable', 'true');
  console.log(JSON.stringify(manifest, null, 2));
}

async function commandCandidateMetadata(args) {
  const manifest = readJson(path.join(path.resolve(args.candidate), 'manifest.json'));
  appendGithubOutput('status', manifest.status);
  appendGithubOutput('has_patch', manifest.status === 'candidate' ? 'true' : 'false');
  appendGithubOutput('retryable', manifest.retryable ? 'true' : 'false');
  appendGithubOutput('issue_number', manifest.issueNumber || '');
  appendGithubOutput('issue_body_sha', manifest.issueBodySha || '');
  appendGithubOutput('profile_path', manifest.profilePath || '');
  appendGithubOutput('fixture_path', manifest.fixturePath || '');
  console.log(JSON.stringify(manifest, null, 2));
}

async function commandApplyCandidate(args) {
  const checked = applyCandidatePatch(args.candidate, args['expected-sha']);
  appendGithubOutput('profile_path', checked.manifest.profilePath);
  appendGithubOutput('fixture_path', checked.manifest.fixturePath);
  console.log(JSON.stringify({ applied: true, issueNumber: checked.manifest.issueNumber, patchSha256: checked.manifest.patchSha256 }, null, 2));
}

async function commandCandidateStatus(args) {
  const manifest = readJson(path.join(path.resolve(args.candidate), 'manifest.json'));
  let report;
  if (manifest.status === 'blocked') {
    report = {
      valid: false,
      retryable: false,
      issueNumber: manifest.issueNumber,
      issueBodySha: manifest.issueBodySha,
      checks: { evidence: { valid: false, errors: [manifest.blocker.message], warnings: [] } }
    };
  } else if (fs.existsSync(args.report)) {
    try {
      report = readJson(args.report);
    } catch (error) {
      report = { valid: false, retryable: true, checks: {}, error: `Validation report is invalid: ${error.message}` };
    }
  } else {
    report = { valid: false, retryable: true, checks: {}, error: 'Validation report was not produced' };
  }
  if (args.output) writeJson(args.output, report);
  if (args['message-output']) syncFailureMessage(args['message-output'], manifest, report, Number(args.attempt || 1));
  appendGithubOutput('valid', report.valid ? 'true' : 'false');
  appendGithubOutput('retryable', report.valid ? 'false' : (report.retryable === false || manifest.retryable === false ? 'false' : 'true'));
  appendGithubOutput('issue_number', manifest.issueNumber || '');
  console.log(JSON.stringify({ valid: report.valid, retryable: report.retryable, issueNumber: manifest.issueNumber }, null, 2));
}

async function commandFinalizeShadow(args) {
  const source = readJson(args.source);
  const report = fs.existsSync(args.report) ? readJson(args.report) : null;
  const eligible = Boolean(source.intake && source.intake.status === 'ready' && !source.error);
  const result = {
    schemaVersion: 1,
    issueNumber: Number(args['issue-number']),
    eligible,
    evidencePassed: eligible && Boolean(report && report.profilePath && report.fixturePath),
    candidateProduced: Boolean(report && report.profilePath && report.fixturePath),
    valid: Boolean(report && report.valid === true),
    retryable: report ? report.retryable !== false : false,
    error: source.error || (report && report.error) || null,
    checks: report ? report.checks : {}
  };
  writeJson(args.output, result);
  console.log(JSON.stringify({ issueNumber: result.issueNumber, eligible: result.eligible, candidateProduced: result.candidateProduced, valid: result.valid }, null, 2));
}

async function commandPreparePublish(args) {
  const result = preparePublish(args.candidate, args.report, {
    provider: args.provider,
    model: args.model,
    reviewCycle: args['review-cycle']
  });
  console.log(JSON.stringify({ issueNumber: result.manifest.issueNumber, profilePath: result.manifest.profilePath, fixturePath: result.manifest.fixturePath }, null, 2));
}

async function commandAssertIssueSha(args) {
  const issue = await githubClient().getIssue(Number(args['issue-number']));
  const intake = parseIssue(issue, { allowExisting: true });
  const matches = intake.issueBodySha === String(args.sha);
  appendGithubOutput('matches', matches ? 'true' : 'false');
  appendGithubOutput('actual_sha', intake.issueBodySha);
  console.log(JSON.stringify({ issueNumber: intake.issueNumber, matches, expectedSha: args.sha, actualSha: intake.issueBodySha }, null, 2));
  if (!matches) process.exitCode = 1;
}

async function commandCancelIssueRuns(args) {
  const cancelled = await githubClient().cancelIssueRuns(Number(args['issue-number']), process.env.GITHUB_RUN_ID);
  console.log(JSON.stringify({ cancelled }, null, 2));
}

async function commandBuildStatus(args) {
  const client = githubClient();
  const issueNumber = Number(args['issue-number']);
  if (args['expected-sha']) {
    const issue = await client.getIssue(issueNumber);
    const current = parseIssue(issue, { allowExisting: true });
    if (current.issueBodySha !== String(args['expected-sha'])) {
      console.log(JSON.stringify({ issueNumber, stale: true, expectedSha: args['expected-sha'], actualSha: current.issueBodySha }, null, 2));
      return;
    }
  }
  const state = String(args.state);
  const label = {
    queued: 'profile:queued',
    generating: 'profile:generating',
    validating: 'profile:validating',
    blocked: 'profile:blocked',
    review: 'profile:review'
  }[state];
  if (!label) throw new Error(`Unsupported build state: ${state}`);
  await client.setStateLabels(issueNumber, label);
  if (args.message) {
    const body = fs.existsSync(args.message) ? fs.readFileSync(args.message, 'utf8') : String(args.message);
    await client.upsertComment(issueNumber, '<!-- profile-automation:build -->', body);
  } else if (args.reason) {
    await client.upsertComment(issueNumber, '<!-- profile-automation:build -->', String(args.reason));
  } else if (args['pr-url']) {
    await client.upsertComment(issueNumber, '<!-- profile-automation:build -->', `Profile Automation created or updated a Draft PR: ${args['pr-url']}\n\nPlease review the evidence matrix and required CI. The bot will never mark it ready, approve it, or merge it.`);
  }
}

async function commandAuthorizeReview(args) {
  const event = eventFrom(args);
  const branch = event.pull_request && event.pull_request.head && event.pull_request.head.ref;
  const match = String(branch || '').match(/^auto-profile-(\d+)$/);
  const username = event.review && event.review.user && event.review.user.login;
  const feedback = String(event.review && event.review.body || '').trim();
  const requestedChanges = event.review && String(event.review.state).toLowerCase() === 'changes_requested';
  const meta = automationMeta(event.pull_request && event.pull_request.body);
  let authorized = false;
  let reason = null;
  let issue = null;
  let intake = null;
  let agent = null;
  let reviewCycle = meta ? Number(meta.reviewCycle || 0) + 1 : 1;
  if (!enabled()) reason = 'Profile Agent execution is disabled by the repository kill switch';
  else if (!match || !meta || meta.issueNumber !== Number(match[1])) reason = 'PR does not contain valid Profile Automation metadata';
  else if (!username || !requestedChanges || !feedback) reason = 'Only a non-empty Request changes review can trigger repair';
  else if (reviewCycle > MAX_REVIEW_CYCLES) reason = `Automatic review repair is limited to ${MAX_REVIEW_CYCLES} cycles`;
  else {
    const configured = String(process.env.PROFILE_APPROVERS || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
    const reviewerAllowed = configured.length > 0
      ? configured.includes(username.toLowerCase())
      : ['admin', 'maintain', 'write'].includes(await githubClient().collaboratorPermission(username));
    if (!reviewerAllowed) reason = 'Reviewer is not authorized for automatic repair';
    else {
      issue = await githubClient().getIssue(Number(match[1]));
      intake = parseIssue(issue, { allowExisting: true });
      if (intake.issueBodySha !== meta.issueBodySha) reason = 'Issue body changed after the Draft PR was generated';
      else {
        agent = resolveProvider(issue.labels || [], { provider: args.provider, model: args.model, effort: args.effort });
        authorized = true;
      }
    }
  }
  appendGithubOutput('authorized', authorized ? 'true' : 'false');
  appendGithubOutput('issue_number', match ? match[1] : '0');
  appendGithubOutput('issue_body_sha', intake ? intake.issueBodySha : '');
  appendGithubOutput('feedback', authorized ? feedback : '');
  appendGithubOutput('review_cycle', authorized ? reviewCycle : '0');
  appendGithubOutput('provider', agent ? agent.provider : '');
  appendGithubOutput('environment', agent ? agent.environment : '');
  appendGithubOutput('model', agent ? agent.model : '');
  appendGithubOutput('effort', agent ? agent.effort : '');
  appendGithubOutput('reason', reason || '');
  console.log(JSON.stringify({ authorized, issueNumber: match ? Number(match[1]) : null, username, reviewCycle, reason }, null, 2));
}

async function commandMerged(args) {
  const event = eventFrom(args);
  const branch = event.pull_request && event.pull_request.head && event.pull_request.head.ref;
  const match = String(branch || '').match(/^auto-profile-(\d+)$/);
  if (!match || !event.pull_request.merged) return;
  const issueNumber = Number(match[1]);
  const client = githubClient();
  await client.setStateLabels(issueNumber, 'profile:generated');
  await client.addLabels(issueNumber, ['profile:unverified']);
  await client.upsertComment(issueNumber, '<!-- profile-automation:merged -->', `The generated Profile was merged in ${event.pull_request.html_url}. It remains unverified until confirmed on real hardware.`);
  await client.closeIssue(issueNumber);
}

async function commandHelp() {
  console.log(`BACnet Profile Automation\n\nCommands:\n  intake\n  fetch-intake\n  apply-intake\n  collect-source\n  prepare-agent-input\n  read-agent-evidence\n  resolve-runtime\n  seed-previous\n  remove-shadow-targets\n  capture-agent-output\n  candidate-metadata\n  apply-candidate\n  candidate-status\n  prepare-publish\n  assert-issue-sha\n  cancel-issue-runs\n  build-status\n  authorize-review\n  merged`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const commands = {
    help: commandHelp,
    intake: commandIntake,
    'fetch-intake': commandFetchIntake,
    'apply-intake': commandApplyIntake,
    'collect-source': commandCollectSource,
    'prepare-agent-input': commandPrepareAgentInput,
    'read-agent-evidence': commandReadAgentEvidence,
    'resolve-runtime': commandResolveRuntime,
    'prepare-advisory-input': commandPrepareAdvisoryInput,
    'prepare-codex-home': commandPrepareCodexHome,
    'seed-previous': commandSeedPrevious,
    'remove-shadow-targets': commandRemoveShadowTargets,
    'capture-agent-output': commandCaptureAgentOutput,
    'record-capture-failure': commandRecordCaptureFailure,
    'candidate-metadata': commandCandidateMetadata,
    'apply-candidate': commandApplyCandidate,
    'candidate-status': commandCandidateStatus,
    'finalize-shadow': commandFinalizeShadow,
    'prepare-publish': commandPreparePublish,
    'assert-issue-sha': commandAssertIssueSha,
    'cancel-issue-runs': commandCancelIssueRuns,
    'build-status': commandBuildStatus,
    'authorize-review': commandAuthorizeReview,
    merged: commandMerged
  };
  if (!commands[command]) throw new Error(`Unknown command '${command || ''}'`);
  await commands[command](args);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
