#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { validateAgentCandidate } = require('./lib/validation/agent-candidate');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  const candidateDirectory = argument('--candidate');
  const sourceBundlePath = argument('--source-bundle');
  const outputPath = argument('--output');
  if (!candidateDirectory || !sourceBundlePath) {
    console.error('Usage: node scripts/validate-agent-candidate.js --candidate <dir> --source-bundle <json> [--output <json>]');
    process.exit(2);
  }
  const root = path.resolve(__dirname, '..');
  const report = validateAgentCandidate({
    root,
    candidateDirectory: path.resolve(candidateDirectory),
    sourceBundlePath: path.resolve(sourceBundlePath),
    includeRepositoryChecks: true
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) fs.writeFileSync(outputPath, serialized, 'utf8');
  process.stdout.write(serialized);
  process.exit(report.valid ? 0 : 1);
}

main();
