'use strict';

const fs = require('fs');
const path = require('path');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const PROVIDER_CATALOG_PATH = path.join(WORKSPACE_ROOT, 'automation', 'config', 'providers.json');
const AGENT_OUTPUT_SCHEMA_PATH = path.join(WORKSPACE_ROOT, '.github', 'codex', 'schemas', 'profile-agent-output.schema.json');
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_TEXT = 120000;
const MAX_ATTEMPTS = 2;
const MAX_REVIEW_CYCLES = 3;
const MAX_AGENT_RESULT_BYTES = 256 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_PROFILE_BYTES = 128 * 1024;
const MAX_FIXTURE_BYTES = 256 * 1024;

function providerCatalog() {
  const catalog = JSON.parse(fs.readFileSync(PROVIDER_CATALOG_PATH, 'utf8'));
  if (!catalog || catalog.schemaVersion !== 1 || !catalog.providers) {
    throw new Error('Provider catalog is invalid');
  }
  return catalog.providers;
}

function normalizedLabels(labels) {
  return (labels || []).map(label => String(typeof label === 'string' ? label : label.name || '').toLowerCase());
}

function resolveProvider(labels, overrides = {}) {
  const catalog = providerCatalog();
  const selectedLabels = normalizedLabels(labels)
    .filter(label => label.startsWith('profile:provider:'))
    .map(label => label.slice('profile:provider:'.length));
  const unique = [...new Set(selectedLabels)];
  if (unique.length > 1) throw new Error(`Multiple Profile Agent providers selected: ${unique.join(', ')}`);

  const provider = String(overrides.provider || unique[0] || process.env.PROFILE_AGENT_DEFAULT_PROVIDER || 'openai').toLowerCase();
  const definition = catalog[provider];
  if (!definition) throw new Error(`Unsupported Profile Agent provider: ${provider}`);
  const model = String(overrides.model || '').trim();
  const effort = String(overrides.effort || '').trim();
  if (effort && !['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error(`Unsupported model effort: ${effort}`);
  return {
    provider,
    environment: `profile-agent-${provider}`,
    model,
    effort
  };
}

function resolveAgentRuntime(provider, overrides = {}) {
  const catalog = providerCatalog();
  const definition = catalog[provider];
  if (!definition) throw new Error(`Unsupported Profile Agent provider: ${provider}`);
  const model = String(overrides.model || process.env.PROFILE_AGENT_MODEL || '').trim();
  const effort = String(overrides.effort || process.env.PROFILE_AGENT_EFFORT || '').trim();
  const responsesEndpoint = String(overrides.responsesEndpoint || process.env.PROFILE_AGENT_RESPONSES_ENDPOINT || definition.responsesEndpoint || '').trim();
  if (!model) throw new Error(`No model configured for Profile Agent provider '${provider}'`);
  if (!effort) throw new Error(`No model effort configured for Profile Agent provider '${provider}'`);
  if (!responsesEndpoint.startsWith('https://')) throw new Error(`Profile Agent Responses endpoint must use HTTPS for provider '${provider}'`);
  if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error(`Unsupported model effort: ${effort}`);
  return { provider, model, effort, responsesEndpoint, environment: `profile-agent-${provider}` };
}

module.exports = {
  WORKSPACE_ROOT,
  PROVIDER_CATALOG_PATH,
  AGENT_OUTPUT_SCHEMA_PATH,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_TEXT,
  MAX_ATTEMPTS,
  MAX_REVIEW_CYCLES,
  MAX_AGENT_RESULT_BYTES,
  MAX_PATCH_BYTES,
  MAX_PROFILE_BYTES,
  MAX_FIXTURE_BYTES,
  providerCatalog,
  resolveProvider,
  resolveAgentRuntime
};
