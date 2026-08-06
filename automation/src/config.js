'use strict';

const path = require('path');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_TEXT = 120000;
const MAX_ATTEMPTS = 3;

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function configuredModel(index) {
  const prefix = `PROFILE_MODEL_${index}`;
  const explicitKey = process.env[`${prefix}_API_KEY`];
  const explicitName = process.env[`${prefix}_NAME`];
  const explicitBaseUrl = process.env[`${prefix}_BASE_URL`];
  if (explicitKey && explicitName && explicitBaseUrl) {
    return {
      apiKey: explicitKey,
      name: explicitName,
      baseUrl: normalizeBaseUrl(explicitBaseUrl),
      label: `${prefix.toLowerCase()}:${explicitName}`
    };
  }

  if (explicitKey || explicitName || explicitBaseUrl) {
    throw new Error(`${prefix} configuration is incomplete. Set ${prefix}_API_KEY, ${prefix}_BASE_URL, and ${prefix}_NAME together.`);
  }
  return null;
}

function modelConfiguration() {
  const primary = configuredModel(1);
  if (!primary) {
    throw new Error('No primary model configured. Set PROFILE_MODEL_1_API_KEY, PROFILE_MODEL_1_BASE_URL, and PROFILE_MODEL_1_NAME.');
  }
  return { primary, secondary: configuredModel(2) };
}

module.exports = {
  WORKSPACE_ROOT,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_TEXT,
  MAX_ATTEMPTS,
  modelConfiguration
};
