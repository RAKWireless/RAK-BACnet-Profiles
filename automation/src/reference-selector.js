'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { WORKSPACE_ROOT } = require('./config');

const REPOSITORY_EXAMPLE_PROFILE_PATH = path.join(
  WORKSPACE_ROOT,
  'profiles',
  'Thermokon',
  'Thermokon-NOVOS3-OccLumCO2TempRH.yaml'
);
const REPOSITORY_EXAMPLE_FIXTURE_PATH = path.join(
  WORKSPACE_ROOT,
  'profiles',
  'Thermokon',
  'tests',
  'Thermokon-NOVOS3-OccLumCO2TempRH.test.json'
);

function tokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9]+/g) || []);
}

function scoreProfile(profile, requestedTokens) {
  const profileTokens = tokens(Object.values(profile.datatype || {}).map(item => `${item.name} ${item.type} ${item.units || ''}`).join(' '));
  let score = 0;
  for (const token of requestedTokens) if (profileTokens.has(token)) score += 1;
  return score;
}

function selectReference(bacnetMapping) {
  const requestedTokens = tokens(bacnetMapping);
  const profilesRoot = path.join(WORKSPACE_ROOT, 'profiles');
  let best = null;
  for (const vendor of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!vendor.isDirectory()) continue;
    const vendorPath = path.join(profilesRoot, vendor.name);
    for (const file of fs.readdirSync(vendorPath)) {
      if (!/\.ya?ml$/i.test(file)) continue;
      try {
        const profile = yaml.load(fs.readFileSync(path.join(vendorPath, file), 'utf8'));
        const score = scoreProfile(profile, requestedTokens);
        if (score > 0 && (!best || score > best.score)) {
          best = {
            score,
            path: `profiles/${vendor.name}/${file}`,
            datatype: profile.datatype,
            lorawan: profile.lorawan
          };
        }
      } catch {
        // Invalid historical profiles are ignored as references.
      }
    }
  }
  return best;
}

function loadRepositoryExample() {
  return {
    profilePath: path.relative(WORKSPACE_ROOT, REPOSITORY_EXAMPLE_PROFILE_PATH),
    fixturePath: path.relative(WORKSPACE_ROOT, REPOSITORY_EXAMPLE_FIXTURE_PATH),
    profileYaml: fs.readFileSync(REPOSITORY_EXAMPLE_PROFILE_PATH, 'utf8'),
    fixture: JSON.parse(fs.readFileSync(REPOSITORY_EXAMPLE_FIXTURE_PATH, 'utf8')),
    cautions: [
      'This is a formal historical repository Profile, not an automation-safe codec template.',
      'Do not copy Encode, encodeDownlink, while loops, partial-payload behavior, or disabled robustness checks.',
      'Generated candidates must follow the current uplink-only and fail-closed requirements.'
    ]
  };
}

module.exports = { selectReference, loadRepositoryExample };
