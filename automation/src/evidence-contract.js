'use strict';

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const { scrubPII } = require('./pii-scrubber');

const SCHEMA_DIRECTORY = path.resolve(__dirname, '..', 'schemas');
const SOURCE_BUNDLE_SCHEMA_PATH = path.join(SCHEMA_DIRECTORY, 'source-bundle.schema.json');
const AGENT_REQUEST_SCHEMA_PATH = path.join(SCHEMA_DIRECTORY, 'agent-request.schema.json');
const MAX_ERROR_MESSAGE = 1000;

let sourceBundleValidator = null;
let agentRequestValidator = null;

function compileSchema(schemaPath) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  return new Ajv({ allErrors: true, strict: false }).compile(schema);
}

function validateWith(validator, value, label) {
  if (!validator(value)) {
    const details = validator.errors
      .map(error => `${error.instancePath || '/'} ${error.message}`)
      .join('; ');
    throw new Error(`${label} does not match schema: ${details}`);
  }
  return value;
}

function assertSourceBundleSemantics(bundle) {
  const expectedAttemptStatus = bundle.source ? 'succeeded' : bundle.sourceError ? 'failed' : 'not-attempted';
  if (bundle.officialDocumentAttempt.status !== expectedAttemptStatus) {
    throw new Error(`Source bundle officialDocumentAttempt.status must be ${expectedAttemptStatus}`);
  }
  if (bundle.source && (bundle.sourceError || bundle.sourceFallback.used || bundle.error)) {
    throw new Error('Source bundle with an official source cannot also report source failure, fallback, or blocking error');
  }
  if (bundle.source && !bundle.officialDocumentAttempt.extraction) {
    throw new Error('Source bundle with an official source must include extraction metadata');
  }
  if (!bundle.source && bundle.officialDocumentAttempt.extraction) {
    throw new Error('Source bundle without an official source cannot include successful extraction metadata');
  }
  if (bundle.sourceFallback.used && (!bundle.sourceError || !bundle.decoder || bundle.sourceFallback.origin !== 'decoder')) {
    throw new Error('Source bundle fallback requires a failed official source and a separate decoder');
  }
  if (!bundle.source && bundle.sourceError && bundle.decoder && !bundle.sourceFallback.used) {
    throw new Error('Source bundle with a decoder fallback must mark sourceFallback.used');
  }
  if (!bundle.source && bundle.sourceError && !bundle.decoder && !bundle.error) {
    throw new Error('Source bundle without official or decoder evidence must contain a blocking error');
  }
  return bundle;
}

function assertAgentRequestSemantics(request) {
  const evidence = request.evidence;
  if (evidence.officialDocument && evidence.officialDocumentAttempt.status !== 'succeeded') {
    throw new Error('Agent request official document requires a succeeded official source attempt');
  }
  if (!evidence.officialDocument && evidence.officialDocumentAttempt.status === 'succeeded') {
    throw new Error('Agent request cannot omit a successfully prepared official document');
  }
  if (evidence.fallback.used && (!evidence.decoder || evidence.officialDocument || evidence.officialDocumentAttempt.status !== 'failed')) {
    throw new Error('Agent request fallback requires a failed official source and a separate decoder');
  }
  return request;
}

function validateSourceBundle(bundle) {
  if (!sourceBundleValidator) sourceBundleValidator = compileSchema(SOURCE_BUNDLE_SCHEMA_PATH);
  return assertSourceBundleSemantics(validateWith(sourceBundleValidator, bundle, 'Source bundle'));
}

function validateAgentRequest(request) {
  if (!agentRequestValidator) agentRequestValidator = compileSchema(AGENT_REQUEST_SCHEMA_PATH);
  return assertAgentRequestSemantics(validateWith(agentRequestValidator, request, 'Agent request'));
}

function serializeContractError(error, options = {}) {
  const message = error && error.message ? error.message : String(error);
  return {
    message: scrubPII(message).slice(0, MAX_ERROR_MESSAGE),
    code: error && error.code ? String(error.code) : options.fallbackCode || null,
    stage: error && error.stage ? String(error.stage) : options.stage || null
  };
}

function sourceExtraction(source) {
  if (!source) return null;
  return {
    type: source.type,
    pages: source.pages || null,
    sha256: source.sha256 || null
  };
}

function officialDocumentAttempt(intake, source, sourceError) {
  return {
    url: source && source.url ? source.url : intake.datasheetUrl || null,
    status: source ? 'succeeded' : sourceError ? 'failed' : 'not-attempted',
    sourceError: sourceError || null,
    extraction: sourceExtraction(source)
  };
}

function normalizeFallback(value, used, reasonCode) {
  if (value && typeof value === 'object') {
    return {
      used: Boolean(value.used),
      origin: value.origin || null,
      reasonCode: value.reasonCode || null
    };
  }
  return {
    used,
    origin: used ? 'decoder' : null,
    reasonCode: used ? reasonCode || null : null
  };
}

function buildSourceBundle(options) {
  const source = options.source || null;
  const decoder = options.decoder || null;
  const sourceError = options.sourceError || null;
  const fallbackUsed = !source && Boolean(decoder) && Boolean(sourceError);
  const bundle = {
    schemaVersion: 2,
    intake: options.intake,
    source,
    officialDocumentAttempt: officialDocumentAttempt(options.intake, source, sourceError),
    sourceError,
    sourceFallback: normalizeFallback(options.sourceFallback, fallbackUsed, sourceError && sourceError.code),
    decoder,
    decoderError: options.decoderError || null,
    evidenceIssues: Array.isArray(options.evidenceIssues) ? options.evidenceIssues : [],
    error: options.error || null
  };
  return validateSourceBundle(bundle);
}

function buildSettledSourceBundle(intake, sourceResult, decoderResult) {
  const decoder = decoderResult.status === 'fulfilled' ? decoderResult.value : null;
  const decoderError = decoderResult.status === 'rejected'
    ? serializeContractError(decoderResult.reason, { stage: 'decoder' })
    : null;
  const source = sourceResult.status === 'fulfilled' ? sourceResult.value : null;
  const sourceError = sourceResult.status === 'rejected'
    ? serializeContractError(sourceResult.reason, { stage: 'source', fallbackCode: 'SOURCE_UNAVAILABLE' })
    : null;
  return buildSourceBundle({
    intake,
    source,
    sourceError,
    decoder,
    decoderError,
    error: sourceError && !decoder ? sourceError : null
  });
}

function legacyDecoderAsSource(source, decoder) {
  if (!source) return false;
  if (source.type === 'decoder') return true;
  return Boolean(decoder && source.sha256 && decoder.sha256 && source.sha256 === decoder.sha256 && source.text === decoder.text);
}

function decoderFromLegacySource(source) {
  return {
    url: source.url || null,
    origin: 'legacy-decoder-as-source',
    authority: 'supporting',
    sha256: source.sha256 || null,
    text: source.text || ''
  };
}

function normalizeSourceBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('Source bundle must be an object');
  }
  if (bundle.schemaVersion === 2) return validateSourceBundle(bundle);
  if (bundle.schemaVersion !== undefined && bundle.schemaVersion !== 1) {
    throw new Error(`Unsupported source bundle schemaVersion: ${bundle.schemaVersion}`);
  }
  if (!bundle.intake || typeof bundle.intake !== 'object') throw new Error('Legacy source bundle is missing intake');

  let source = bundle.source || null;
  let decoder = bundle.decoder || null;
  let sourceError = bundle.sourceError
    ? serializeContractError(bundle.sourceError, { stage: 'source', fallbackCode: 'SOURCE_UNAVAILABLE' })
    : null;
  let sourceFallback = bundle.sourceFallback || null;

  if (legacyDecoderAsSource(source, decoder)) {
    if (!decoder) decoder = decoderFromLegacySource(source);
    source = null;
    sourceError = sourceError || {
      message: 'Official source was unavailable in a legacy bundle; the original failure detail was not preserved',
      code: 'SOURCE_UNAVAILABLE',
      stage: 'source'
    };
    sourceFallback = { used: true, origin: 'decoder', reasonCode: sourceError.code };
  } else if (!source && decoder && !sourceError) {
    sourceError = {
      message: 'Official source was unavailable in a legacy bundle; the original failure detail was not preserved',
      code: 'SOURCE_UNAVAILABLE',
      stage: 'source'
    };
    sourceFallback = { used: true, origin: 'decoder', reasonCode: sourceError.code };
  }

  const decoderError = bundle.decoderError
    ? serializeContractError(bundle.decoderError, { stage: 'decoder' })
    : null;
  const error = bundle.error
    ? serializeContractError(bundle.error, { stage: bundle.error.stage || null })
    : null;
  if (!source && !sourceError && error && bundle.intake.status === 'ready' &&
      !['INTAKE_NOT_READY', 'INVALID_EXPECTED_SHA', 'ISSUE_SHA_MISMATCH'].includes(error.code)) {
    sourceError = serializeContractError(error, { stage: 'source', fallbackCode: 'SOURCE_UNAVAILABLE' });
  }
  return buildSourceBundle({
    intake: bundle.intake,
    source,
    sourceError,
    sourceFallback,
    decoder,
    decoderError,
    evidenceIssues: bundle.evidenceIssues,
    error
  });
}

module.exports = {
  SOURCE_BUNDLE_SCHEMA_PATH,
  AGENT_REQUEST_SCHEMA_PATH,
  serializeContractError,
  validateSourceBundle,
  validateAgentRequest,
  buildSourceBundle,
  buildSettledSourceBundle,
  normalizeSourceBundle
};
