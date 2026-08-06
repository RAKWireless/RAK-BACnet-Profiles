#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { parseIssue } = require('../automation/src/issue-parser');
const { scrubPII } = require('../automation/src/pii-scrubber');
const { analyzeCodecSafety } = require('./lib/validation/codec-safety');
const { validateProfileSemantics } = require('./lib/validation/profile-semantics');
const { validateTestFixture } = require('./lib/validation/test-fixture');
const { runGeneratedProfileCI } = require('./run-profile-ci');
const { buildCandidate, readCandidate, normalizeFixture } = require('../automation/src/candidate');
const { validateEvidence } = require('../automation/src/evidence');
const { GitHubClient } = require('../automation/src/github-client');
const { isPrivateAddress, createPinnedLookup } = require('../automation/src/source-loader');
const { validateRequestedMapping } = require('./lib/validation/requested-mapping');
const { getModelsWithTests } = require('./update-registry');

const SAFE_CODEC = `function Decode(fPort, data, variables) {
  if (data.length < 2) return [];
  var values = [];
  if (fPort === 10) {
    values.push({name: "Temperature", channel: 1, value: ((data[0] << 8) | data[1]) / 10, unit: "degreesCelsius"});
  }
  return values;
}
function decodeUplink(input) {
  if (!input || !Array.isArray(input.bytes)) return {data: [], errors: ["invalid input"]};
  if (input.fPort !== 10) return {data: [], errors: ["unsupported fPort"]};
  if (input.bytes.length < 2) return {data: [], errors: ["truncated payload"]};
  return {data: Decode(input.fPort, input.bytes, input.variables)};
}`;

function syntheticIssue() {
  return {
    number: 99,
    title: '[Profile Request] Acme - T100',
    html_url: 'https://github.com/example/repo/issues/99',
    body: `### Device Vendor

Acme

### Device Model

T100

### Product Manual/Datasheet Link

https://example.com/manual.pdf

### LoRaWAN Class

Class A

### LoRaWAN Protocol Version

LORAWAN_1_0_3

### Uplink Data Examples

\`\`\`text
fPort 10: 00 FA
\`\`\`

### Decode Function (Optional)

\`\`\`code
function Decoder(bytes) { return bytes[0]; }
\`\`\`

### Downlink Support

No - uplink only

### BACnet Object Mapping Requirements

- Temperature → AnalogInputObject (degreesCelsius)

### Email

customer@example.com`
  };
}

function testIssueParsing() {
  const parsed = parseIssue(syntheticIssue(), { allowExisting: true });
  assert.equal(parsed.status, 'ready');
  assert.equal(parsed.profileName, 'Acme-T100');
  assert.deepEqual(parsed.uplinkExamples.map(item => ({ fPort: item.fPort, hex: item.hex })), [{ fPort: 10, hex: '00FA' }]);
  assert(!JSON.stringify(parsed).includes('customer@example.com'));

  const missingPort = syntheticIssue();
  missingPort.body = missingPort.body.replace('fPort 10: 00 FA', '00 FA');
  assert.equal(parseIssue(missingPort, { allowExisting: true }).status, 'needs-info');

  const inheritedPort = syntheticIssue();
  inheritedPort.body = inheritedPort.body.replace('fPort 10: 00 FA', 'fPort 10: 00 FA\n01 02 03 04 05 06');
  assert.equal(parseIssue(inheritedPort, { allowExisting: true }).status, 'needs-info');
}

function testPiiScrubbingDoesNotCorruptPayloads() {
  const input = 'Email: user@example.com\nPayload: 01 41 15 01 5C 77 88 B6\nFormula: (764 - 500) / 10';
  const scrubbed = scrubPII(input);
  assert(!scrubbed.includes('user@example.com'));
  assert(scrubbed.includes('01 41 15 01 5C 77 88 B6'));
  assert(scrubbed.includes('(764 - 500) / 10'));
}

function testSafetyRules() {
  assert.equal(analyzeCodecSafety(SAFE_CODEC).valid, true);
  assert.equal(analyzeCodecSafety('function decodeUplink(input) { return process.env; }').valid, false);
  assert.equal(analyzeCodecSafety('function decodeUplink(input) { while (true) {} }').valid, false);
  assert.equal(analyzeCodecSafety('function decodeUplink(input) { return {data: [], time: Date.now()}; }').valid, false);
  assert.equal(analyzeCodecSafety('function a() { return b(); } function b() { return a(); } function decodeUplink() { return a(); }').valid, false);
}

function testNetworkBoundaryRules() {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('10.0.0.1'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
}

function testPinnedDnsLookupSupportsNode20() {
  const lookup = createPinnedLookup({ address: '203.0.113.10', family: 4 });
  let allResult;
  lookup('example.com', { all: true }, (error, addresses) => {
    allResult = { error, addresses };
  });
  assert.equal(allResult.error, null);
  assert.deepEqual(allResult.addresses, [{ address: '203.0.113.10', family: 4 }]);

  let singleResult;
  lookup('example.com', {}, (error, address, family) => {
    singleResult = { error, address, family };
  });
  assert.deepEqual(singleResult, { error: null, address: '203.0.113.10', family: 4 });
}

function testRegistryUsesCommittedFixtureFormatOnly() {
  const vendorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rak-registry-tests-'));
  const testsDir = path.join(vendorDir, 'tests');
  fs.mkdirSync(testsDir);
  try {
    fs.writeFileSync(path.join(testsDir, 'test-data.json'), JSON.stringify({ testCases: [{ model: 'Legacy' }] }));
    fs.writeFileSync(path.join(testsDir, 'expected-output.json'), JSON.stringify({ testCases: [] }));
    assert.deepEqual([...getModelsWithTests(vendorDir)], []);

    fs.writeFileSync(path.join(testsDir, 'Acme-T100.test.json'), JSON.stringify({ profile: 'Acme-T100' }));
    assert.deepEqual([...getModelsWithTests(vendorDir)], ['acmet100']);
  } finally {
    fs.rmSync(vendorDir, { recursive: true, force: true });
  }
}

async function testStateLabelsReplacePreviousState() {
  const client = new GitHubClient('example/repository', 'test-token');
  const calls = [];
  client.ensureLabel = async () => {};
  client.getIssue = async () => ({
    labels: [
      { name: 'profile-request' },
      { name: 'profile:ready' },
      { name: 'profile:generating' },
      { name: 'profile:unverified' }
    ]
  });
  client.request = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    return {};
  };

  await client.setStateLabels(32, 'profile:blocked');
  assert.deepEqual(calls, [{
    method: 'PUT',
    endpoint: '/issues/32/labels',
    body: { labels: ['profile-request', 'profile:unverified', 'profile:blocked'] }
  }]);
}

function testIntakeDirectlyStartsBuild() {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'profile-intake.yml'), 'utf8');
  assert.match(workflow, /status:\s*\$\{\{ steps\.intake\.outputs\.status \}\}/);
  assert.match(workflow, /issue_number:\s*\$\{\{ steps\.intake\.outputs\.issue_number \}\}/);
  assert.match(workflow, /if:\s*needs\.intake\.outputs\.status == 'ready'/);
  assert.match(workflow, /uses:\s*\.\/\.github\/workflows\/profile-build\.yml/);
  assert.match(workflow, /issue_number:\s*\$\{\{ fromJSON\(needs\.intake\.outputs\.issue_number\) \}\}/);

  const buildWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'profile-build.yml'), 'utf8');
  assert.match(buildWorkflow, /- name: Fail generation after blocker is reported\s+run: exit 1/);
}

function testScriptLayout() {
  const repositoryRoot = path.join(__dirname, '..');
  const expectedInternalFiles = [
    'lib/codec-sandbox.js',
    'lib/hex-converter.js',
    'lib/units.js',
    'lib/yaml-parser.js',
    'lib/validation/codec-safety.js',
    'lib/validation/profile-semantics.js',
    'lib/validation/requested-mapping.js',
    'lib/validation/test-fixture.js',
    'schemas/bacnet-mapping-rules.json',
    'schemas/profile-schema.json',
    'schemas/profile-test-schema.json'
  ];
  for (const relativePath of expectedInternalFiles) {
    assert(fs.existsSync(path.join(__dirname, relativePath)), `Missing organized script file: ${relativePath}`);
  }
  assert.equal(fs.existsSync(path.join(__dirname, 'utils')), false);
  assert.equal(fs.readdirSync(__dirname).some(name => name.endsWith('.py')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'automation')), true);
  assert.equal(fs.existsSync(path.join(repositoryRoot, ['automation', 'v2'].join('-'))), false);

  const workflowsDirectory = path.join(repositoryRoot, '.github', 'workflows');
  const workflows = fs.readdirSync(workflowsDirectory)
    .filter(name => /\.ya?ml$/.test(name))
    .map(name => fs.readFileSync(path.join(workflowsDirectory, name), 'utf8'))
    .join('\n');
  assert.match(workflows, /actions\/checkout@v7/);
  assert.match(workflows, /actions\/setup-node@v7/);
  assert.match(workflows, /actions\/upload-artifact@v7/);
  assert.match(workflows, /actions\/download-artifact@v8/);
  assert.match(workflows, /node-version:\s*24/);
  assert.doesNotMatch(workflows, /actions\/(?:checkout|setup-node|upload-artifact|download-artifact)@v4\b/);
  assert.doesNotMatch(workflows, /node-version:\s*20\b/);
}

function testEvidenceGates() {
  const intake = parseIssue(syntheticIssue(), { allowExisting: true });
  const incomplete = {
    messageTypes: [{ name: 'sensor', fPorts: [10], minimumLength: 2, fields: [{ name: 'Temperature', offset: 0, length: null, citation: 'Manual p.1' }] }],
    knownAnswers: [],
    ambiguities: []
  };
  assert(validateEvidence(incomplete, intake).some(item => item.includes('byte length')));

  const evidenceWithUnsubmittedKnownAnswer = {
    knownAnswers: [{ fPort: 10, input: '0001', expectedOutput: { temperature: 0.1 }, citation: 'Manual p.2' }]
  };
  const fixture = normalizeFixture({ testCases: [{ fPort: 10, input: '00FA' }] }, intake, evidenceWithUnsubmittedKnownAnswer, 'single-model');
  assert.equal(fixture.evidenceLevel, 'documentation-only');
}

function testRequestedBacnetMapping() {
  const profile = {
    datatype: {
      '1': { name: 'Temperature', type: 'AnalogInputObject', units: 'degreesCelsius' }
    }
  };
  assert.equal(validateRequestedMapping(profile, '- Temperature → AnalogInputObject (degreesCelsius)').valid, true);
  assert.equal(validateRequestedMapping(profile, '- Temperature → BinaryInputObject').valid, false);
  assert.equal(validateRequestedMapping(profile, '- Humidity → AnalogInputObject (percent)').valid, false);
}

function testGeneratedProfileContract() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rak-profile-v2-'));
  const vendorDir = path.join(temporaryRoot, 'profiles', 'Acme');
  const testsDir = path.join(vendorDir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  const profilePath = path.join(vendorDir, 'Acme-T100.yaml');
  const fixturePath = path.join(testsDir, 'Acme-T100.test.json');
  const profile = {
    codec: SAFE_CODEC,
    datatype: {
      '1': { name: 'Temperature', type: 'AnalogInputObject', units: 'degreesCelsius', channel: 1, updateInterval: 600, covIncrement: 0.1 }
    },
    lorawan: { macVersion: 'LORAWAN_1_0_3', supportClassB: false, supportClassC: false },
    model: 'Acme-T100',
    profileVersion: '1.0.0',
    name: 'T100',
    vendor: 'Acme',
    id: '123e4567-e89b-42d3-a456-426614174000'
  };
  const fixture = {
    schemaVersion: 1,
    profile: 'Acme-T100',
    evidenceLevel: 'known-answer',
    reviewMode: 'single-model',
    sources: [{ type: 'issue', reference: 'Issue #99' }],
    robustness: { checkTruncation: true, checkUnknownFPort: true },
    testCases: [{
      name: 'Temperature example',
      fPort: 10,
      input: '00FA',
      expectedOutput: [{ name: 'Temperature', channel: 1, value: 25, unit: 'degreesCelsius' }]
    }]
  };
  fs.writeFileSync(profilePath, yaml.dump(profile, { lineWidth: -1 }), 'utf8');
  fs.writeFileSync(fixturePath, JSON.stringify(fixture), 'utf8');
  assert.equal(validateProfileSemantics(profile, profilePath, { strict: true }).valid, true);
  assert.equal(validateTestFixture(profilePath, fixturePath).valid, true);
  assert.equal(runGeneratedProfileCI(profilePath, fixturePath).valid, true);

  const profileWithDownlinkChannel = {
    ...profile,
    datatype: {
      ...profile.datatype,
      '20': { name: 'Set Temperature', type: 'AnalogOutputObject', units: 'degreesCelsius', channel: 20, fport: 10 }
    }
  };
  fs.writeFileSync(profilePath, yaml.dump(profileWithDownlinkChannel, { lineWidth: -1 }), 'utf8');
  assert.equal(validateTestFixture(profilePath, fixturePath).valid, true);

  const unsafeTruncationProfile = {
    ...profile,
    codec: `function Decode(fPort, data) { return [{name: "Temperature", channel: 1, value: 0, unit: "degreesCelsius"}]; }
function decodeUplink(input) { return {data: Decode(input.fPort, input.bytes)}; }`
  };
  fs.writeFileSync(profilePath, yaml.dump(unsafeTruncationProfile, { lineWidth: -1 }), 'utf8');
  assert.equal(validateTestFixture(profilePath, fixturePath).valid, false);
}

async function withMockModel(responses, callback) {
  const queue = [...responses];
  const server = http.createServer((request, response) => {
    const next = queue.shift();
    response.writeHead(next ? 200 : 500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(next ? { choices: [{ message: { content: JSON.stringify(next) } }] } : { error: 'No response queued' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    return await callback({ apiKey: 'test', name: 'mock', baseUrl: `http://127.0.0.1:${address.port}`, label: 'mock:model' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testEndToEndCandidateBuild() {
  const evidence = {
    messageTypes: [{
      name: 'sensor',
      fPorts: [10],
      selector: null,
      minimumLength: 2,
      citation: 'Manual p.1',
      fields: [{
        name: 'Temperature', offset: 0, length: 2, bits: null, endianness: 'big-endian', signed: false,
        scale: 0.1, formula: 'raw / 10', unit: 'degreesCelsius', citation: 'Manual p.1'
      }]
    }],
    knownAnswers: [{ fPort: 10, input: '00FA', expectedOutput: { temperature: 25 }, citation: 'Manual p.1' }],
    conflicts: [], ambiguities: [], unsupported: []
  };
  const generated = {
    profileYaml: yaml.dump({
      codec: SAFE_CODEC,
      datatype: { '1': { name: 'Temperature', type: 'AnalogInputObject', units: 'degreesCelsius', channel: 1, updateInterval: 600, covIncrement: 0.1 } },
      lorawan: { macVersion: 'LORAWAN_1_0_3', supportClassB: false, supportClassC: false }
    }, { lineWidth: -1 }),
    fixture: {
      testCases: [{
        name: 'Temperature example', fPort: 10, input: '00FA',
        expectedOutput: [{ name: 'Temperature', channel: 1, value: 25, unit: 'degreesCelsius' }]
      }]
    }
  };
  const approvedReview = { approved: true, severity: 'none', findings: [], fieldChecks: [], attackCases: [] };
  await withMockModel([evidence, generated, approvedReview, approvedReview], async model => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rak-profile-candidate-'));
    const intake = parseIssue(syntheticIssue(), { allowExisting: true });
    const manifest = await buildCandidate({
      models: { primary: model, secondary: null },
      intake,
      source: { url: intake.datasheetUrl, type: 'pdf', pages: 1, sha256: 'a'.repeat(64), text: 'Protocol text with a two-byte big-endian temperature value on fPort 10. '.repeat(5) },
      outputDir,
      attempt: 1
    });
    assert.equal(manifest.status, 'candidate');
    const candidate = readCandidate(outputDir);
    assert.equal(candidate.fixture.reviewMode, 'single-model');
    assert.equal(candidate.fixture.evidenceLevel, 'known-answer');
    assert.equal(runGeneratedProfileCI(path.join(outputDir, manifest.profilePath), path.join(outputDir, manifest.fixturePath)).valid, true);
  });
}

async function main() {
  testIssueParsing();
  testPiiScrubbingDoesNotCorruptPayloads();
  testSafetyRules();
  testNetworkBoundaryRules();
  testPinnedDnsLookupSupportsNode20();
  testRegistryUsesCommittedFixtureFormatOnly();
  await testStateLabelsReplacePreviousState();
  testIntakeDirectlyStartsBuild();
  testScriptLayout();
  testEvidenceGates();
  testRequestedBacnetMapping();
  testGeneratedProfileContract();
  await testEndToEndCandidateBuild();
  console.log('Profile Automation tests: PASS');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
