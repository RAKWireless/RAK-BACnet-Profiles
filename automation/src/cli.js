#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { WORKSPACE_ROOT, MAX_ATTEMPTS, modelConfiguration } = require('./config');
const { parseIssue } = require('./issue-parser');
const { loadOfficialSource, decoderFallbackSource } = require('./source-loader');
const { loadDecoder } = require('./decoder-loader');
const { GitHubClient } = require('./github-client');
const { buildCandidate, readCandidate, writeGenerationError } = require('./candidate');
const { parseArgs, readJson, writeJson, writeText, appendGithubOutput } = require('./io');
const { combinedStatus, writeStatusOutputs, failureMarkdown, preparePublish } = require('./status');

function githubClient() {
  return new GitHubClient(process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN);
}

function serializeError(error) {
  return {
    message: error && error.message ? error.message : String(error),
    code: error && error.code ? error.code : null
  };
}

function restoreError(value) {
  const error = new Error(value && value.message ? value.message : 'Source collection failed');
  if (value && value.code) error.code = value.code;
  return error;
}

function attemptNumber(value) {
  const attempt = Number(value || 1);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS) {
    throw new Error(`Attempt must be an integer between 1 and ${MAX_ATTEMPTS}`);
  }
  return attempt;
}

function attachDecoderEvidence(intake, decoder) {
  if (!decoder || !decoder.text) return intake;
  return {
    ...intake,
    decoderSource: decoder.text,
    decoderOrigin: decoder.origin,
    decoderUrl: decoder.url,
    decoderSha256: decoder.sha256 || null,
    decoderAuthority: decoder.authority || 'supporting',
    decoderAuthorityReason: decoder.authorityReason || null
  };
}

function intakeComment(intake) {
  if (intake.status === 'ready') {
    const deferred = (intake.warnings || []).length > 0
      ? `\n\nThe following items will be resolved during evidence extraction:\n\n${intake.warnings.map(item => `- ${item}`).join('\n')}`
      : '';
    return `The request passed the Profile Automation completeness gate and has been queued for uplink-only profile generation.${deferred}`;
  }
  if (intake.status === 'manual' || intake.status === 'duplicate') {
    const reasons = [...(intake.errors || []), ...(intake.warnings || [])];
    return `This request is outside Profile Automation scope and requires manual handling.\n\n${reasons.map(item => `- ${item}`).join('\n')}`;
  }
  return `Please edit the original Issue to resolve the following items; do not add the answers only in comments.\n\n${intake.errors.map(item => `- ${item}`).join('\n')}`;
}

async function commandIntake(args) {
  const event = readJson(args.event || process.env.GITHUB_EVENT_PATH);
  const intake = parseIssue(event.issue || event);
  if (args.output) writeJson(args.output, intake);
  appendGithubOutput('status', intake.status);
  appendGithubOutput('issue_number', intake.issueNumber || '');
  console.log(JSON.stringify(intake, null, 2));
}

async function commandApplyIntake(args) {
  const intake = readJson(args.intake);
  if (intake.status === 'ignored') return;
  const client = githubClient();
  const labels = {
    ready: 'profile:ready',
    'needs-info': 'profile:needs-info',
    manual: 'profile:manual',
    duplicate: 'profile:manual'
  };
  const activeLabel = labels[intake.status] || 'profile:needs-info';
  if (intake.status === 'ready') await client.removeLabel(intake.issueNumber, activeLabel);
  await client.setStateLabels(intake.issueNumber, activeLabel);
  await client.upsertComment(intake.issueNumber, '<!-- profile-automation:intake -->', intakeComment(intake));
}

async function commandFetchIntake(args) {
  const issue = await githubClient().getIssue(Number(args['issue-number']));
  const intake = parseIssue(issue, { allowExisting: args['allow-existing'] === true });
  if (args.output) writeJson(args.output, intake);
  appendGithubOutput('status', intake.status);
  appendGithubOutput('eligible', intake.status === 'ready' ? 'true' : 'false');
  console.log(JSON.stringify(intake, null, 2));
}

async function commandIntakeMetadata(args) {
  const intake = readJson(args.intake);
  appendGithubOutput('status', intake.status || 'unknown');
  appendGithubOutput('eligible', intake.status === 'ready' ? 'true' : 'false');
  appendGithubOutput('issue_number', intake.issueNumber || '');
  console.log(JSON.stringify(intake, null, 2));
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
    if (sourceResult.status === 'fulfilled') {
      source = sourceResult.value;
    } else if (decoder) {
      source = decoderFallbackSource(intake, decoder);
    } else {
      const sourceError = sourceResult.reason;
      if (!sourceError.code) sourceError.code = 'SOURCE_UNAVAILABLE';
      error = serializeError(sourceError);
    }
  } catch (caught) {
    if (!caught.code) caught.code = 'SOURCE_UNAVAILABLE';
    error = serializeError(caught);
  }
  const bundle = { intake, source, decoder, decoderError, error };
  writeJson(args.output, bundle);
  if (args['intake-output']) writeJson(args['intake-output'], intake);
  console.log(JSON.stringify({
    issueNumber: intake.issueNumber,
    intakeStatus: intake.status,
    source: source && {
      url: source.url,
      type: source.type,
      pages: source.pages,
      sha256: source.sha256,
      textLength: String(source.text || '').length
    },
    decoder: decoder && {
      origin: decoder.origin,
      url: decoder.url,
      sha256: decoder.sha256,
      authority: decoder.authority,
      textLength: String(decoder.text || '').length
    },
    decoderError,
    error
  }, null, 2));
}

async function commandGenerate(args) {
  let intake;
  let source = null;
  let collectionError = null;
  let decoder = null;
  let decoderCollected = false;
  if (args.bundle) {
    const bundle = readJson(args.bundle);
    intake = bundle.intake;
    source = bundle.source || null;
    collectionError = bundle.error || null;
    decoder = bundle.decoder || null;
    decoderCollected = true;
  } else {
    const issueNumber = Number(args['issue-number']);
    const issue = await githubClient().getIssue(issueNumber);
    intake = parseIssue(issue, { allowExisting: args['allow-existing'] === true });
  }
  const attempt = attemptNumber(args.attempt);
  let manifest;
  try {
    if (collectionError) throw restoreError(collectionError);
    if (intake.status !== 'ready') {
      const error = new Error(`Issue is not ready for generation: ${intake.status}: ${(intake.errors || []).join('; ')}`);
      error.code = 'INTAKE_NOT_READY';
      throw error;
    }
    if (!decoder && !decoderCollected) {
      try {
        decoder = await loadDecoder(intake, { token: process.env.GITHUB_TOKEN });
      } catch {
        decoder = null;
      }
    }
    intake = attachDecoderEvidence(intake, decoder);
    if (!source) {
      try {
        source = await loadOfficialSource(intake);
      } catch (sourceError) {
        if (decoder) source = decoderFallbackSource(intake, decoder);
        else throw sourceError;
      }
    }
    manifest = await buildCandidate({
      models: modelConfiguration(),
      intake,
      source,
      outputDir: path.resolve(args.output),
      attempt,
      feedback: process.env.PROFILE_REVIEW_FEEDBACK || ''
    });
  } catch (error) {
    manifest = writeGenerationError(path.resolve(args.output), intake, source, attempt, error);
  }
  console.log(JSON.stringify(manifest, null, 2));
}

async function commandRepair(args) {
  const previous = readCandidate(path.resolve(args.candidate));
  const validationReport = readJson(args.report);
  const attempt = attemptNumber(args.attempt);
  let source = previous.context.source;
  let manifest;
  try {
    if (!source) source = await loadOfficialSource(previous.context.intake);
    manifest = await buildCandidate({
      models: modelConfiguration(),
      intake: previous.context.intake,
      source,
      outputDir: path.resolve(args.output),
      attempt,
      previous: previous.manifest.profilePath ? previous : null,
      validationReport,
      feedback: process.env.PROFILE_REVIEW_FEEDBACK || ''
    });
  } catch (error) {
    manifest = writeGenerationError(path.resolve(args.output), previous.context.intake, source, attempt, error);
  }
  console.log(JSON.stringify(manifest, null, 2));
}

async function commandCandidateStatus(args) {
  const candidateDir = path.resolve(args.candidate);
  const candidate = readCandidate(candidateDir);
  const extraChecks = {};
  if (candidate.manifest.profilePath) {
    const yaml = require('js-yaml');
    const { validateRequestedMapping } = require('../../scripts/lib/validation/requested-mapping');
    extraChecks.requestedMapping = validateRequestedMapping(yaml.load(candidate.profileYaml), candidate.context.intake.bacnetMapping);
  }
  const status = combinedStatus(candidateDir, path.resolve(args.report), extraChecks);
  if (!status.ci.available) writeJson(args.report, status.ci);
  if (args.output) writeJson(args.output, status);
  if (args['message-output']) writeText(args['message-output'], failureMarkdown(status));
  writeStatusOutputs(status);
  console.log(JSON.stringify(status, null, 2));
}

async function commandPreparePublish(args) {
  const result = preparePublish(path.resolve(args.candidate), WORKSPACE_ROOT);
  console.log(JSON.stringify(result, null, 2));
}

async function commandCandidateMetadata(args) {
  const candidateDir = path.resolve(args.candidate);
  const manifest = readJson(path.join(candidateDir, 'manifest.json'));
  const publishable = Boolean(manifest.profilePath && manifest.fixturePath);
  appendGithubOutput('publishable', publishable ? 'true' : 'false');
  appendGithubOutput('profile_path', manifest.profilePath || '');
  appendGithubOutput('fixture_path', manifest.fixturePath || '');
  appendGithubOutput('issue_number', manifest.issueNumber || '');
  console.log(JSON.stringify({ publishable, ...manifest }, null, 2));
}

async function commandBlockedReport(args) {
  const manifest = readJson(path.join(path.resolve(args.candidate), 'manifest.json'));
  const stage = ['intake', 'source', 'evidence', 'generation', 'repair', 'normalization', 'review'].includes(manifest.stage)
    ? manifest.stage
    : (manifest.status === 'evidence-blocked' ? 'evidence' : 'generation');
  writeJson(args.output, {
    valid: false,
    checks: {
      [stage]: {
        valid: false,
        errors: [manifest.reason || 'Candidate is not publishable', ...(manifest.details || [])],
        warnings: []
      }
    }
  });
}

async function commandShadowIneligible(args) {
  const intake = readJson(args.intake);
  writeJson(args.output, {
    eligible: false,
    valid: false,
    issueNumber: intake.issueNumber,
    status: intake.status,
    errors: intake.errors || [],
    warnings: intake.warnings || []
  });
}

async function commandFinalizeShadow(args) {
  const directory = path.resolve(args.directory);
  let selected = null;
  for (let attempt = MAX_ATTEMPTS; attempt >= 1; attempt -= 1) {
    const candidate = path.join(directory, `attempt-${attempt}.json`);
    if (fs.existsSync(candidate)) {
      selected = readJson(candidate);
      break;
    }
  }
  if (!selected) throw new Error('No shadow attempt report was produced');
  writeJson(args.output, selected);
  console.log(JSON.stringify(selected, null, 2));
}

async function commandBuildStatus(args) {
  const client = githubClient();
  const issueNumber = Number(args['issue-number']);
  const state = args.state;
  const label = {
    generating: 'profile:generating',
    blocked: 'profile:blocked',
    review: 'profile:review'
  }[state];
  if (!label) throw new Error(`Unsupported build state: ${state}`);
  await client.setStateLabels(issueNumber, label);
  if (args.message) {
    const body = fs.existsSync(args.message)
      ? fs.readFileSync(args.message, 'utf8')
      : 'Profile Automation stopped without producing a complete validation report. A maintainer should inspect the failed workflow run; no PR was created.';
    await client.upsertComment(issueNumber, '<!-- profile-automation:build -->', body);
  } else if (args.reason) {
    await client.upsertComment(issueNumber, '<!-- profile-automation:build -->', String(args.reason));
  } else if (args['pr-url']) {
    await client.upsertComment(issueNumber, '<!-- profile-automation:build -->', `Profile Automation created or updated a Draft PR: ${args['pr-url']}\n\nPlease review the evidence packet and CI results. The bot will never merge automatically.`);
  }
}

async function commandAuthorizeReview(args) {
  const event = readJson(args.event || process.env.GITHUB_EVENT_PATH);
  const branch = event.pull_request && event.pull_request.head && event.pull_request.head.ref;
  const match = String(branch || '').match(/^auto-profile-(\d+)$/);
  const username = event.review && event.review.user && event.review.user.login;
  const requestedChanges = event.review && String(event.review.state).toLowerCase() === 'changes_requested';
  let authorized = false;
  if (match && username && requestedChanges) {
    const configured = String(process.env.PROFILE_APPROVERS || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
    if (configured.length > 0) {
      authorized = configured.includes(username.toLowerCase());
    } else {
      const permission = await githubClient().collaboratorPermission(username);
      authorized = ['admin', 'maintain', 'write'].includes(permission);
    }
  }
  appendGithubOutput('authorized', authorized ? 'true' : 'false');
  appendGithubOutput('issue_number', match ? match[1] : '0');
  appendGithubOutput('feedback', authorized ? (event.review.body || '') : '');
  console.log(JSON.stringify({ authorized, issueNumber: match ? Number(match[1]) : null, username }, null, 2));
}

async function commandDispatchValidation(args) {
  const ref = String(args.ref || '');
  if (!/^auto-profile-\d+$/.test(ref)) throw new Error(`Invalid automated profile branch: ${ref}`);
  await githubClient().dispatchWorkflow('validate-profiles.yml', ref);
  console.log(JSON.stringify({ dispatched: true, workflow: 'validate-profiles.yml', ref }, null, 2));
}

async function commandMerged(args) {
  const event = readJson(args.event || process.env.GITHUB_EVENT_PATH);
  const branch = event.pull_request && event.pull_request.head && event.pull_request.head.ref;
  const match = String(branch || '').match(/^auto-profile-(\d+)$/);
  if (!match || !event.pull_request.merged) return;
  const issueNumber = Number(match[1]);
  const client = githubClient();
  await client.setStateLabels(issueNumber, 'profile:generated');
  await client.addLabels(issueNumber, ['profile:unverified']);
  await client.upsertComment(issueNumber, '<!-- profile-automation:merged -->', `The generated profile was merged in ${event.pull_request.html_url}. It remains unverified until confirmed on real hardware.`);
  await client.closeIssue(issueNumber);
}

async function commandHelp() {
  console.log(`BACnet Profile Automation\n\nCommands:\n  intake\n  intake-metadata\n  apply-intake\n  fetch-intake\n  collect-source\n  generate\n  repair\n  candidate-metadata\n  candidate-status\n  prepare-publish\n  build-status\n  authorize-review\n  dispatch-validation\n  finalize-shadow\n  merged`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const commands = {
    help: commandHelp,
    intake: commandIntake,
    'intake-metadata': commandIntakeMetadata,
    'fetch-intake': commandFetchIntake,
    'collect-source': commandCollectSource,
    'apply-intake': commandApplyIntake,
    generate: commandGenerate,
    repair: commandRepair,
    'candidate-status': commandCandidateStatus,
    'candidate-metadata': commandCandidateMetadata,
    'blocked-report': commandBlockedReport,
    'shadow-ineligible': commandShadowIneligible,
    'finalize-shadow': commandFinalizeShadow,
    'prepare-publish': commandPreparePublish,
    'build-status': commandBuildStatus,
    'authorize-review': commandAuthorizeReview,
    'dispatch-validation': commandDispatchValidation,
    merged: commandMerged
  };
  if (!commands[command]) throw new Error(`Unknown command '${command || ''}'`);
  await commands[command](args);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
