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
const {
  buildCandidate,
  readCandidate,
  normalizeProfileYaml,
  normalizeFixture,
  resolveIntakeFPorts,
  resolveIntakeMapping,
  candidatePreflight,
  writeGenerationError
} = require('../automation/src/candidate');
const { buildEvidence, validateEvidence, normalizeEvidence, classifyEvidenceFinding } = require('../automation/src/evidence');
const { GitHubClient } = require('../automation/src/github-client');
const { isPrivateAddress, createPinnedLookup, decoderFallbackSource } = require('../automation/src/source-loader');
const {
  loadDecoder,
  isDecoderCode,
  extractDecoderUrl,
  githubRawUrl,
  relevantToDevice
} = require('../automation/src/decoder-loader');
const { modelConfiguration } = require('../automation/src/config');
const { loadRepositoryExample, selectReference } = require('../automation/src/reference-selector');
const { failureMarkdown } = require('../automation/src/status');
const { evaluate: evaluateShadowRun } = require('./evaluate-shadow-run');
const { DEFAULT_TIMEOUT_MS, completeJson, isRetryableStatus } = require('../automation/src/model-client');
const {
  parseRequestedMappings,
  analyzeRequestedMappings,
  validateRequestedMapping
} = require('./lib/validation/requested-mapping');
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

const AGNOSTIC_CODEC = `function Decode(fPort, data, variables) {
  if (data.length < 2) return [];
  return [{name: "Temperature", channel: 1, value: ((data[0] << 8) | data[1]) / 10, unit: "degreesCelsius"}];
}
function decodeUplink(input) {
  if (!input || !Array.isArray(input.bytes)) return {data: [], errors: ["invalid input"]};
  if (input.fPort < 1 || input.fPort > 223) return {data: [], errors: ["unsupported fPort"]};
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

  const nonstandardTitle = syntheticIssue();
  nonstandardTitle.title = 'Please add support for my sensor';
  const parsedNonstandardTitle = parseIssue(nonstandardTitle, { allowExisting: true });
  assert.equal(parsedNonstandardTitle.status, 'ready');
  assert.equal(parsedNonstandardTitle.vendor, 'Acme');
  assert.equal(parsedNonstandardTitle.model, 'T100');
  assert.equal(parsedNonstandardTitle.profileName, 'Acme-T100');
  assert(parsedNonstandardTitle.warnings.some(item => item.includes('Device Vendor and Device Model')));

  const unrelatedIssue = syntheticIssue();
  unrelatedIssue.title = '[Bug] Something is broken';
  unrelatedIssue.body = '### Description\n\nThis is not a Profile request.';
  assert.equal(parseIssue(unrelatedIssue).status, 'ignored');

  const missingPort = syntheticIssue();
  missingPort.body = missingPort.body.replace('fPort 10: 00 FA', '00 FA');
  const parsedMissingPort = parseIssue(missingPort, { allowExisting: true });
  assert.equal(parsedMissingPort.status, 'ready');
  assert.equal(parsedMissingPort.fPortStatus, 'deferred');
  assert.equal(parsedMissingPort.uplinkExamples[0].fPort, null);
  assert(parsedMissingPort.warnings.some(item => item.includes('evidence stage')));

  const inheritedPort = syntheticIssue();
  inheritedPort.body = inheritedPort.body.replace('fPort 10: 00 FA', 'fPort 10: 00 FA\n01 02 03 04 05 06');
  assert.equal(parseIssue(inheritedPort, { allowExisting: true }).status, 'ready');

  const markdownPort = syntheticIssue();
  markdownPort.body = markdownPort.body.replace('fPort 10: 00 FA', '- **fPort:** 10\nHex: 00 FA');
  const parsedMarkdownPort = parseIssue(markdownPort, { allowExisting: true });
  assert.equal(parsedMarkdownPort.status, 'ready');
  assert.equal(parsedMarkdownPort.uplinkExamples[0].fPort, 10);

  const singleSectionPort = syntheticIssue();
  singleSectionPort.body = singleSectionPort.body.replace('fPort 10: 00 FA', 'Hex: 00 FA\nfPort: 10');
  const parsedSingleSectionPort = parseIssue(singleSectionPort, { allowExisting: true });
  assert.equal(parsedSingleSectionPort.status, 'ready');
  assert.equal(parsedSingleSectionPort.uplinkExamples[0].fPort, 10);

  const ambiguousSectionPort = syntheticIssue();
  ambiguousSectionPort.body = ambiguousSectionPort.body.replace('fPort 10: 00 FA', 'Payload: 00 FA\nfPort: 10\nfPort: 11');
  const parsedAmbiguousSectionPort = parseIssue(ambiguousSectionPort, { allowExisting: true });
  assert.equal(parsedAmbiguousSectionPort.status, 'ready');
  assert.equal(parsedAmbiguousSectionPort.fPortStatus, 'deferred');

  const legacyMapping = syntheticIssue();
  legacyMapping.body = legacyMapping.body.replace(
    '- Temperature → AnalogInputObject (degreesCelsius)',
    'Temperature → Analog Input (AI) – Units: °C'
  );
  const parsedLegacyMapping = parseIssue(legacyMapping, { allowExisting: true });
  assert.equal(parsedLegacyMapping.status, 'ready');
  assert.equal(parsedLegacyMapping.requestedMappings[0].type, 'AnalogInputObject');
  assert.equal(parsedLegacyMapping.requestedMappings[0].units, 'degreesCelsius');

  const documentMapping = syntheticIssue();
  documentMapping.body = documentMapping.body.replace(
    '- Temperature → AnalogInputObject (degreesCelsius)',
    'Please reference the official document pages 83-95 for the BACnet data point definitions.'
  );
  const parsedDocumentMapping = parseIssue(documentMapping, { allowExisting: true });
  assert.equal(parsedDocumentMapping.status, 'ready');
  assert.equal(parsedDocumentMapping.bacnetMappingStatus, 'deferred');
  assert.equal(parsedDocumentMapping.bacnetMappingReferences[0].pages, '83-95');

  const unresolvedMapping = syntheticIssue();
  unresolvedMapping.body = unresolvedMapping.body.replace(
    '- Temperature → AnalogInputObject (degreesCelsius)',
    'Please see the documentation.'
  );
  assert.equal(parseIssue(unresolvedMapping, { allowExisting: true }).status, 'needs-info');
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

function testPinnedDnsLookupSupportsModernNode() {
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

async function testDecoderDiscovery() {
  const decoderText = 'function decodeUplink(input) { return { data: { model: "T100" } }; }';
  assert.equal(isDecoderCode(decoderText), true);
  assert.equal(isDecoderCode('function Decode(fPort, bytes) { return bytes; }'), true);
  assert.equal(isDecoderCode('function Decoder(bytes) { return bytes; }'), true);
  assert.equal(extractDecoderUrl('Decoder: https://example.com/T100-decoder.js'), 'https://example.com/T100-decoder.js');
  assert.equal(extractDecoderUrl('Manual: https://example.com/manual.pdf#decoder'), null);
  assert.equal(
    githubRawUrl('https://github.com/acme/codecs/blob/main/T100/decoder.js'),
    'https://raw.githubusercontent.com/acme/codecs/main/T100/decoder.js'
  );
  assert.equal(relevantToDevice({ url: 'https://example.com/T100/decoder.js', text: decoderText }, 'DifferentVendor', 'T100'), true);

  let externalCalls = 0;
  const inline = await loadDecoder({ issueNumber: 99, vendor: 'Acme', model: 'T100', decoder: decoderText }, {
    download: async () => { externalCalls += 1; return null; },
    search: async () => { externalCalls += 1; return null; }
  });
  assert.equal(inline.origin, 'issue-inline');
  assert.equal(inline.authority, 'user-provided');
  assert.equal(externalCalls, 0);

  let downloadedUrl = null;
  const linked = await loadDecoder({ issueNumber: 99, vendor: 'Acme', model: 'T100', decoder: 'https://example.com/T100-decoder.js' }, {
    download: async url => {
      downloadedUrl = url;
      return { text: decoderText, url, sha256: 'a'.repeat(64) };
    },
    search: async () => null
  });
  assert.equal(downloadedUrl, 'https://example.com/T100-decoder.js');
  assert.equal(linked.origin, 'issue-url');
  assert.equal(linked.authority, 'user-provided');

  let treeRequest = null;
  const treeLinked = await loadDecoder({
    issueNumber: 99,
    vendor: 'Acme',
    model: 'T100',
    decoder: 'https://github.com/acme/codecs/tree/main/T100'
  }, {
    downloadTree: async (url, token) => {
      treeRequest = { url, token };
      return { text: decoderText, url: 'https://raw.githubusercontent.com/acme/codecs/main/T100/decoder.js', sha256: 'd'.repeat(64) };
    },
    download: async () => null,
    search: async () => null
  });
  assert.deepEqual(treeRequest, { url: 'https://github.com/acme/codecs/tree/main/T100', token: undefined });
  assert.equal(treeLinked.origin, 'issue-url');
  assert.equal(treeLinked.authority, 'user-provided');

  let searchRequest = null;
  const searched = await loadDecoder({ issueNumber: 99, vendor: 'Acme', model: 'T100', decoder: '' }, {
    search: async (vendor, model) => {
      searchRequest = { vendor, model };
      return { text: decoderText, url: 'https://github.com/acme/codecs/T100.js', sha256: 'b'.repeat(64) };
    }
  });
  assert.deepEqual(searchRequest, { vendor: 'Acme', model: 'T100' });
  assert.equal(searched.origin, 'github-search');
  assert.equal(searched.authority, 'supporting');

  const missing = await loadDecoder({ issueNumber: 99, vendor: 'Acme', model: 'T100', decoder: '' }, {
    search: async () => null
  });
  assert.equal(missing, null);

  const fallback = decoderFallbackSource({ issueNumber: 99 }, linked);
  assert.equal(fallback.type, 'decoder');
  assert.equal(fallback.url, linked.url);
  assert.equal(fallback.sha256, linked.sha256);
  assert.equal(fallback.text, decoderText);
}

function testUnifiedModelConfiguration() {
  const environmentNames = [
    'PROFILE_MODEL_1_API_KEY',
    'PROFILE_MODEL_1_BASE_URL',
    'PROFILE_MODEL_1_NAME',
    'PROFILE_MODEL_2_API_KEY',
    'PROFILE_MODEL_2_BASE_URL',
    'PROFILE_MODEL_2_NAME'
  ];
  const original = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
  try {
    for (const name of environmentNames) delete process.env[name];
    assert.throws(() => modelConfiguration(), /No primary model configured/);

    process.env.PROFILE_MODEL_1_API_KEY = 'primary-key';
    process.env.PROFILE_MODEL_1_BASE_URL = 'https://models.example.test/v1/';
    process.env.PROFILE_MODEL_1_NAME = 'test-model';
    assert.deepEqual(modelConfiguration(), {
      primary: {
        apiKey: 'primary-key',
        name: 'test-model',
        baseUrl: 'https://models.example.test/v1',
        label: 'profile_model_1:test-model'
      },
      secondary: null
    });

    process.env.PROFILE_MODEL_2_API_KEY = 'incomplete-secondary-key';
    assert.throws(() => modelConfiguration(), /PROFILE_MODEL_2 configuration is incomplete/);
  } finally {
    for (const name of environmentNames) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
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
  assert.match(workflow, /intake:\s+if:\s*contains\(github\.event\.issue\.labels\.\*\.name, 'profile-request'\)/);
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

  const variableLengthEvidence = normalizeEvidence({
    messageTypes: [{
      name: 'history',
      fPorts: [10],
      minimumLength: 18,
      citation: 'Manual p.17',
      fields: [
        { name: 'type', offset: 3, length: 1, citation: 'Manual p.17' },
        { name: 'crc', offset: -2, length: 2, citation: 'Manual p.17' }
      ],
      repeatedStructures: [{
        name: 'sensorDataSets',
        startOffset: 10,
        stride: 6,
        minCount: 1,
        maxCount: 5,
        untilTrailerBytes: 2,
        citation: 'Manual p.17',
        fields: [
          { name: 'temperature', offset: 0, offsetFromEnd: null, length: 2, citation: 'Manual p.17' },
          { name: 'humidity', offset: 1, offsetFromEnd: null, length: 2, citation: 'Manual p.17' },
          { name: 'co2', offset: 3, offsetFromEnd: null, length: 2, citation: 'Manual p.17' },
          { name: 'battery', offset: 5, offsetFromEnd: null, length: 1, citation: 'Manual p.17' }
        ]
      }]
    }],
    knownAnswers: [],
    ambiguities: []
  });
  assert.equal(variableLengthEvidence.messageTypes[0].fields[1].offset, null);
  assert.equal(variableLengthEvidence.messageTypes[0].fields[1].offsetFromEnd, 2);
  assert.deepEqual(validateEvidence(variableLengthEvidence, intake), []);

  const invalidRepeatedEvidence = normalizeEvidence(variableLengthEvidence);
  invalidRepeatedEvidence.messageTypes[0].repeatedStructures[0].fields[3].length = 2;
  assert(validateEvidence(invalidRepeatedEvidence, intake).some(item => item.includes('exceeds its stride')));

  const evidenceWithUnsubmittedKnownAnswer = {
    knownAnswers: [{ fPort: 10, input: '0001', expectedOutput: { temperature: 0.1 }, citation: 'Manual p.2' }]
  };
  const fixture = normalizeFixture({ testCases: [{ fPort: 10, input: '00FA' }] }, intake, evidenceWithUnsubmittedKnownAnswer, 'single-model');
  assert.equal(fixture.evidenceLevel, 'documentation-only');

  const userProvidedDecoderFixture = normalizeFixture(
    { testCases: [{ fPort: 10, input: '00FA' }] },
    {
      ...intake,
      decoderSource: 'function Decode() { return []; }',
      decoderOrigin: 'issue-url',
      decoderUrl: 'https://raw.githubusercontent.com/acme/codecs/main/T100/decoder.js',
      decoderSha256: 'd'.repeat(64),
      decoderAuthority: 'user-provided'
    },
    evidenceWithUnsubmittedKnownAnswer,
    'single-model',
    { url: intake.datasheetUrl, type: 'pdf', sha256: 'e'.repeat(64) }
  );
  assert(userProvidedDecoderFixture.sources.some(source => (
    source.type === 'customer-data' && source.citation.includes('User-provided authoritative protocol decoder')
  )));

  const deferredIssue = syntheticIssue();
  deferredIssue.body = deferredIssue.body.replace(
    '- Temperature → AnalogInputObject (degreesCelsius)',
    'Please reference the official document pages 83-95 for the BACnet data point definitions.'
  );
  const deferredIntake = parseIssue(deferredIssue, { allowExisting: true });
  const completeEvidence = {
    messageTypes: [{
      name: 'sensor', fPorts: [10], minimumLength: 2,
      fields: [{ name: 'Temperature', offset: 0, length: 2, citation: 'Manual p.83' }]
    }],
    requestedMappings: [],
    knownAnswers: [],
    ambiguities: []
  };
  assert(validateEvidence(completeEvidence, deferredIntake).some(item => item.includes('BACnet mappings')));
  completeEvidence.requestedMappings = [{
    name: 'Temperature', type: 'Analog Input (AI)', units: '°C', citation: 'Manual p.83'
  }];
  assert.equal(validateEvidence(completeEvidence, deferredIntake).some(item => item.includes('BACnet mapping')), false);

  const missingPortIssue = syntheticIssue();
  missingPortIssue.body = missingPortIssue.body.replace('fPort 10: 00 FA', 'Payload: 00 FA');
  const missingPortIntake = parseIssue(missingPortIssue, { allowExisting: true });
  const unresolvedPortEvidence = {
    messageTypes: [{
      name: 'sensor', fPorts: [], minimumLength: 2,
      fields: [{ name: 'Temperature', offset: 0, length: 2, citation: 'Manual p.1' }]
    }],
    knownAnswers: [],
    ambiguities: []
  };
  assert(validateEvidence(unresolvedPortEvidence, missingPortIntake).some(item => item.includes('fixed or port-agnostic')));

  const fixedPortEvidence = {
    ...unresolvedPortEvidence,
    fPortPolicy: { mode: 'fixed', ports: [10], citation: 'Vendor decoder checks fPort 10' },
    messageTypes: [{ ...unresolvedPortEvidence.messageTypes[0], fPorts: [10] }]
  };
  assert.equal(validateEvidence(fixedPortEvidence, missingPortIntake).length, 0);
  const fixedResolved = resolveIntakeFPorts(missingPortIntake, fixedPortEvidence);
  assert.equal(fixedResolved.uplinkExamples[0].fPort, 10);
  assert.deepEqual(fixedResolved.fPortPolicy, { mode: 'fixed', ports: [10], citation: 'Vendor decoder checks fPort 10' });

  const agnosticPortEvidence = {
    ...unresolvedPortEvidence,
    fPortPolicy: { mode: 'agnostic', ports: [], representativeFPort: 1, citation: 'Vendor decoder never reads fPort' }
  };
  assert.equal(validateEvidence(agnosticPortEvidence, missingPortIntake).length, 0);
  const agnosticResolved = resolveIntakeFPorts(missingPortIntake, agnosticPortEvidence);
  assert.equal(agnosticResolved.uplinkExamples[0].fPort, 1);
  assert.deepEqual(agnosticResolved.fPortPolicy, { mode: 'agnostic', representativeFPort: 1, citation: 'Vendor decoder never reads fPort' });

  const multiPortIssue = syntheticIssue();
  multiPortIssue.body = multiPortIssue.body.replace('fPort 10: 00 FA', 'Payload: 00 FA\nPayload: 01 02');
  const multiPortIntake = parseIssue(multiPortIssue, { allowExisting: true });
  const multiPortEvidence = {
    messageTypes: [{
      name: 'messages', fPorts: [1, 2], minimumLength: 2,
      fields: [{ name: 'Temperature', offset: 0, length: 2, citation: 'Manual p.1' }]
    }],
    fPortPolicy: { mode: 'fixed', ports: [1, 2], citation: 'Manual p.1' },
    uplinkAssignments: [
      { exampleIndex: 1, input: '00FA', fPort: 1, citation: 'Manual selector table' },
      { exampleIndex: 2, input: '0102', fPort: 2, citation: 'Manual selector table' }
    ],
    knownAnswers: [],
    ambiguities: []
  };
  assert.equal(validateEvidence(multiPortEvidence, multiPortIntake).length, 0);
  assert.deepEqual(resolveIntakeFPorts(multiPortIntake, multiPortEvidence).uplinkExamples.map(item => item.fPort), [1, 2]);
}

function testRequestedBacnetMapping() {
  const profile = {
    datatype: {
      '1': { name: 'Temperature', type: 'AnalogInputObject', units: 'degreesCelsius' },
      '2': { name: 'High Temperature Alarm', type: 'BinaryInputObject' },
      '3': { name: 'Low Battery Alarm', type: 'BinaryInputObject' }
    }
  };
  assert.equal(validateRequestedMapping(profile, '- Temperature → AnalogInputObject (degreesCelsius)').valid, true);
  assert.equal(validateRequestedMapping(profile, '- High Temperature Alarm → BinaryInputObject').valid, true);
  assert.equal(validateRequestedMapping(profile, '- Low Battery Alarm → BinaryInputObject').valid, true);
  assert.equal(validateRequestedMapping(profile, '- Temperature → BinaryInputObject').valid, false);
  assert.equal(validateRequestedMapping(profile, '- Humidity → AnalogInputObject (percent)').valid, false);
  assert.equal(validateRequestedMapping(profile, 'Temperature → Analog Input (AI) – Units: °C').valid, true);
  assert.equal(validateRequestedMapping(profile, 'Temperature → AI – Units: °C').valid, true);
  assert.equal(validateRequestedMapping(profile, 'Temperature → AI – Units: bananas').valid, false);
  assert.equal(validateRequestedMapping(profile, 'High Temperature Alarm → BI – Units: bananas').valid, false);
  assert.deepEqual(parseRequestedMappings('| Temperature | Analog Input (AI) – Units: °C |')[0], {
    name: 'Temperature',
    type: 'AnalogInputObject',
    units: 'degreesCelsius',
    rawType: 'Analog Input (AI) – Units: °C'
  });
  const deferred = analyzeRequestedMappings('Please reference the official document Page 83-95 definition of BACnet Data Point');
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.references[0].pages, '83-95');
  assert.equal(validateRequestedMapping(profile, 'Please reference the official document Page 83-95').valid, false);

  const deferredIssue = syntheticIssue();
  deferredIssue.body = deferredIssue.body.replace(
    '- Temperature → AnalogInputObject (degreesCelsius)',
    'Please reference the official document Page 83-95 definition of BACnet Data Point'
  );
  const resolved = resolveIntakeMapping(parseIssue(deferredIssue, { allowExisting: true }), {
    requestedMappings: [{ name: 'Temperature', type: 'Analog Input (AI)', units: '°C', citation: 'Manual p.83' }]
  });
  assert.equal(resolved.bacnetMapping, '- Temperature → AnalogInputObject (degreesCelsius)');
  assert.equal(resolved.bacnetMappingSource, 'deferred');
}

function testAlarmSemanticRulePrecedence() {
  const profile = {
    codec: SAFE_CODEC,
    datatype: {
      '1': { name: 'Temperature', type: 'AnalogInputObject', units: 'degreesCelsius' },
      '2': { name: 'High Temperature Alarm', type: 'BinaryInputObject' },
      '3': { name: 'Low Battery Alarm', type: 'BinaryInputObject' },
      '4': { name: 'Humidity High Alert', type: 'BinaryInputObject' }
    },
    vendor: 'Acme',
    name: 'T100'
  };
  assert.deepEqual(validateProfileSemantics(profile, null, { strict: false }).errors, []);
}

function testFormalRepositoryExample() {
  const example = loadRepositoryExample();
  assert.match(example.profileYaml, /function Decode\(/);
  assert.match(example.profileYaml, /function decodeUplink\(/);
  assert.equal(example.fixture.profile, 'Thermokon-NOVOS3-OccLumCO2TempRH');
  assert.match(example.profilePath, /^profiles\/Thermokon\//);
  assert.equal(example.cautions.length > 0, true);
  assert.equal(validateTestFixture(
    path.join(__dirname, '..', example.profilePath),
    path.join(__dirname, '..', example.fixturePath)
  ).valid, true);

  const targetPath = 'profiles/QingPing/QingPing-CGP22CLH.yaml';
  const reference = selectReference(
    '- temperature → AnalogInputObject\n- humidity → AnalogInputObject\n- co2Value → AnalogInputObject\n- battery → AnalogInputObject',
    { excludePath: targetPath }
  );
  assert(reference);
  assert.notEqual(reference.path, targetPath);
}

function testEvidenceFailureMessagingAndShadowMetrics() {
  const schemaStatus = {
    errors: ['Message history field crc must include a valid byte location'],
    manifest: { status: 'evidence-blocked', code: 'EVIDENCE_SCHEMA_INVALID', attempt: 1 }
  };
  assert.doesNotMatch(failureMarkdown(schemaStatus), /Please edit the original Issue/);
  assert.match(failureMarkdown(schemaStatus), /Automation will retry evidence extraction/);

  const sourceStatus = {
    errors: ['The official source does not state the temperature offset'],
    manifest: { status: 'evidence-blocked', code: 'EVIDENCE_SOURCE_BLOCKED', attempt: 1 }
  };
  assert.match(failureMarkdown(sourceStatus), /Please edit the original Issue/);

  const metrics = evaluateShadowRun([
    { eligible: true, valid: false, manifest: { status: 'evidence-blocked' } },
    { eligible: true, valid: false, manifest: { status: 'review-failed', profilePath: 'a.yaml', fixturePath: 'a.json' } },
    { eligible: true, valid: true, manifest: { status: 'candidate', profilePath: 'b.yaml', fixturePath: 'b.json' } }
  ]);
  assert.equal(metrics.evidenceBlockedIssues, 1);
  assert.equal(metrics.publishableCandidateIssues, 2);
  assert.equal(metrics.evidencePassRate, 2 / 3);
  assert.equal(metrics.candidateSuccessRate, 1 / 2);
  assert.equal(metrics.automaticSuccessRate, 1 / 3);
  assert.equal(metrics.sampleSizeSufficient, false);
}

function testGeneratedCodecNormalization() {
  const intake = parseIssue(syntheticIssue(), { allowExisting: true });
  const rawProfile = {
    codec: `javascript\n${SAFE_CODEC}`,
    datatype: { '1': { name: 'Temperature', type: 'AnalogInputObject', units: 'degreesCelsius' } },
    lorawan: {}
  };
  const normalized = normalizeProfileYaml(yaml.dump(rawProfile, { lineWidth: -1 }), intake);
  const profile = yaml.load(normalized);
  assert.match(profile.codec, /^function Decode\(/);
  assert.equal(candidatePreflight(normalized).valid, true);

  rawProfile.codec = `\`\`\`javascript\n${SAFE_CODEC}\n\`\`\``;
  const fenced = yaml.load(normalizeProfileYaml(yaml.dump(rawProfile, { lineWidth: -1 }), intake));
  assert.equal(fenced.codec.includes('```'), false);

  rawProfile.codec = 'javascript';
  assert.throws(
    () => normalizeProfileYaml(yaml.dump(rawProfile, { lineWidth: -1 }), intake),
    /Generated codec preflight failed/
  );

  rawProfile.codec = `${SAFE_CODEC}\nfunction Encode() { return []; }`;
  assert.throws(
    () => normalizeProfileYaml(yaml.dump(rawProfile, { lineWidth: -1 }), intake),
    /must be uplink-only/
  );
}

function testGenerationErrorStageReporting() {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rak-profile-error-'));
  const intake = parseIssue(syntheticIssue(), { allowExisting: true });
  const error = new Error('Generated codec preflight failed');
  error.code = 'INVALID_GENERATED_CODEC';
  error.stage = 'normalization';
  const manifest = writeGenerationError(outputDir, intake, null, 1, error);
  assert.equal(manifest.stage, 'normalization');
  assert.equal(manifest.retryable, true);
}

async function testTransientModelRequestRetry() {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    if (requests === 1) {
      response.writeHead(429, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'rate limited' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const result = await completeJson(
      { apiKey: 'test', name: 'mock', baseUrl: `http://127.0.0.1:${address.port}`, label: 'mock:model' },
      [{ role: 'user', content: 'test' }],
      { maxRetries: 1, retryDelayMs: 0, timeoutMs: 1000 }
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(requests, 2);
    assert.equal(DEFAULT_TIMEOUT_MS, 300000);
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(400), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testModelRequestHeartbeatDoesNotLeakPayload() {
  const server = http.createServer((request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    }, 40);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const logs = [];
  const originalLog = console.log;
  console.log = value => logs.push(String(value));
  try {
    const address = server.address();
    await completeJson(
      { apiKey: 'super-secret-key', name: 'mock', baseUrl: `http://127.0.0.1:${address.port}`, label: 'mock:model' },
      [{ role: 'user', content: 'super-secret-prompt' }],
      { maxRetries: 0, heartbeatMs: 10, timeoutMs: 1000, operation: 'heartbeat-test' }
    );
    const output = logs.join('\n');
    assert.match(output, /still waiting for HTTP response/);
    assert.doesNotMatch(output, /super-secret-key/);
    assert.doesNotMatch(output, /super-secret-prompt/);
  } finally {
    console.log = originalLog;
    await new Promise(resolve => server.close(resolve));
  }
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

  const profileWithOptionalInput = {
    ...profile,
    datatype: {
      ...profile.datatype,
      '2': { name: 'Humidity', type: 'AnalogInputObject', units: 'percentRelativeHumidity', channel: 2, updateInterval: 600, covIncrement: 0.1 }
    }
  };
  fs.writeFileSync(profilePath, yaml.dump(profileWithOptionalInput, { lineWidth: -1 }), 'utf8');
  const knownAnswerCoverage = validateTestFixture(profilePath, fixturePath);
  assert.equal(knownAnswerCoverage.valid, false);
  assert(knownAnswerCoverage.errors.some(error => error.includes('datatype channels: 2')));

  const documentationOnlyFixture = {
    ...fixture,
    evidenceLevel: 'documentation-only',
    testCases: fixture.testCases.map(({ expectedOutput, ...testCase }) => testCase)
  };
  fs.writeFileSync(fixturePath, JSON.stringify(documentationOnlyFixture), 'utf8');
  const documentationCoverage = validateTestFixture(profilePath, fixturePath);
  assert.equal(documentationCoverage.valid, true);
  assert(documentationCoverage.warnings.some(warning => warning.includes('datatype channels: 2')));

  const agnosticProfile = { ...profile, codec: AGNOSTIC_CODEC };
  const agnosticFixture = {
    ...fixture,
    fPortPolicy: {
      mode: 'agnostic',
      representativeFPort: 10,
      citation: 'Vendor decoder does not inspect fPort'
    }
  };
  fs.writeFileSync(profilePath, yaml.dump(agnosticProfile, { lineWidth: -1 }), 'utf8');
  fs.writeFileSync(fixturePath, JSON.stringify(agnosticFixture), 'utf8');
  assert.equal(validateTestFixture(profilePath, fixturePath).valid, true);

  fs.writeFileSync(profilePath, yaml.dump(profile, { lineWidth: -1 }), 'utf8');
  const falselyAgnostic = validateTestFixture(profilePath, fixturePath);
  assert.equal(falselyAgnostic.valid, false);
  assert(falselyAgnostic.errors.some(error => error.includes('port-agnostic decoder')));

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

function protocolEvidence(unit = 'degreesCelsius') {
  return {
    messageTypes: [{
      name: 'sensor',
      fPorts: [10],
      selector: null,
      minimumLength: 2,
      citation: 'Manual p.1',
      fields: [{
        name: 'Temperature', offset: 0, length: 2, bits: null, endianness: 'big-endian', signed: false,
        scale: 0.1, formula: 'raw / 10', unit, citation: 'Manual p.1'
      }]
    }],
    requestedMappings: [],
    knownAnswers: [],
    conflicts: [],
    ambiguities: [],
    unsupported: []
  };
}

async function testEvidenceReconciliationSeverity() {
  const intake = parseIssue(syntheticIssue(), { allowExisting: true });
  const source = {
    url: intake.datasheetUrl,
    type: 'pdf',
    pages: 1,
    sha256: 'c'.repeat(64),
    text: 'Protocol text with a two-byte big-endian temperature value on fPort 10. '.repeat(5)
  };
  const valid = protocolEvidence();
  const schemaInvalid = protocolEvidence();
  schemaInvalid.messageTypes[0].fields[0].length = null;
  await withMockModel([schemaInvalid], async model => {
    const result = await buildEvidence({ primary: model, secondary: null }, intake, source);
    assert.equal(result.approved, false);
    assert.equal(result.retryable, true);
    assert.equal(result.blockerType, 'schema');
  });

  const sourceBlocked = { ...protocolEvidence(), ambiguities: ['The official source does not state the byte offset for Temperature.'] };
  await withMockModel([sourceBlocked], async model => {
    const result = await buildEvidence({ primary: model, secondary: null }, intake, source);
    assert.equal(result.approved, false);
    assert.equal(result.retryable, false);
    assert.equal(result.blockerType, 'source');
  });

  const primaryIncomplete = { ...protocolEvidence(), messageTypes: [], ambiguities: ['The first extraction failed to locate the message table'] };
  await withMockModel([
    primaryIncomplete,
    valid,
    { approved: true, findings: [], conflicts: [], ambiguities: [], consolidated: valid }
  ], async model => {
    const result = await buildEvidence({ primary: model, secondary: model }, intake, source);
    assert.equal(result.approved, true);
    assert.equal(result.consolidated.messageTypes.length, 1);
  });

  const aliasEvidence = protocolEvidence('°C');
  await withMockModel([
    aliasEvidence,
    valid,
    {
      approved: false,
      findings: [{ severity: 'warning', category: 'format', message: "Equivalent unit aliases '°C' and 'degreesCelsius'" }],
      conflicts: [],
      ambiguities: [],
      consolidated: aliasEvidence
    }
  ], async model => {
    const result = await buildEvidence({ primary: model, secondary: model }, intake, source);
    assert.equal(result.approved, true);
    assert.equal(result.consolidated.messageTypes[0].fields[0].unit, 'degreesCelsius');
    assert.equal(result.warnings.length, 1);
  });

  assert.equal(classifyEvidenceFinding("Equivalent units '°C' and 'degreesCelsius'").severity, 'warning');
  assert.equal(classifyEvidenceFinding({ severity: 'warning', category: 'format', message: 'fPort 10 versus fPort 11' }).severity, 'blocking');
  assert.equal(classifyEvidenceFinding({ severity: 'warning', category: 'format', message: 'fPort formatting differs: 10 versus 11' }).severity, 'blocking');

  const userProvidedDecoderContext = {
    intake: {
      ...intake,
      decoderAuthority: 'user-provided'
    },
    evidence: valid
  };
  assert.equal(classifyEvidenceFinding(
    'No explicit decoded values are stated for the uplink examples, so no knownAnswers can be confirmed.',
    'ambiguity',
    userProvidedDecoderContext
  ).severity, 'warning');
  assert.equal(classifyEvidenceFinding(
    'The unit for batteryLevel (fPort 9) is not documented.',
    'ambiguity',
    userProvidedDecoderContext
  ).severity, 'warning');
  assert.equal(classifyEvidenceFinding(
    'The unit for Temperature is not documented.',
    'ambiguity',
    userProvidedDecoderContext
  ).severity, 'blocking');
  assert.equal(classifyEvidenceFinding(
    "The exact bitmask mapping is only evidenced by the decoder; the README does not document it.",
    'ambiguity',
    userProvidedDecoderContext
  ).severity, 'warning');
  assert.equal(classifyEvidenceFinding(
    'The decoder conflicts with the manual: bit 0 versus bit 2.',
    'conflict',
    userProvidedDecoderContext
  ).severity, 'blocking');

  const documentationOnlyEvidence = {
    ...valid,
    knownAnswers: [],
    ambiguities: [
      'No explicit decoded values are stated for any uplink example, so no knownAnswers can be confirmed.',
      'The unit for batteryLevel (fPort 9) is not documented.',
      "The exact bitmask mapping is only evidenced by the decoder; the README does not document it."
    ]
  };
  await withMockModel([documentationOnlyEvidence], async model => {
    const result = await buildEvidence({ primary: model, secondary: null }, userProvidedDecoderContext.intake, source);
    assert.equal(result.approved, true);
    assert.equal(result.warnings.length, 3);
    assert.equal(result.ambiguities.length, 0);
    assert.equal(result.consolidated.ambiguities.length, 0);
  });
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
    assert.equal(candidate.context.repositoryExample.fixture.profile, 'Thermokon-NOVOS3-OccLumCO2TempRH');
    assert.equal(runGeneratedProfileCI(path.join(outputDir, manifest.profilePath), path.join(outputDir, manifest.fixturePath)).valid, true);
  });
}

async function main() {
  testIssueParsing();
  testPiiScrubbingDoesNotCorruptPayloads();
  testSafetyRules();
  testNetworkBoundaryRules();
  testPinnedDnsLookupSupportsModernNode();
  await testDecoderDiscovery();
  testUnifiedModelConfiguration();
  testRegistryUsesCommittedFixtureFormatOnly();
  await testStateLabelsReplacePreviousState();
  testIntakeDirectlyStartsBuild();
  testScriptLayout();
  testEvidenceGates();
  testRequestedBacnetMapping();
  testAlarmSemanticRulePrecedence();
  testFormalRepositoryExample();
  testEvidenceFailureMessagingAndShadowMetrics();
  testGeneratedCodecNormalization();
  testGenerationErrorStageReporting();
  testGeneratedProfileContract();
  await testTransientModelRequestRetry();
  await testModelRequestHeartbeatDoesNotLeakPayload();
  await testEvidenceReconciliationSeverity();
  await testEndToEndCandidateBuild();
  console.log('Profile Automation tests: PASS');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
