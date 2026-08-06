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

  if (index === 1 && process.env.QWEN_API_KEY) {
    return {
      apiKey: process.env.QWEN_API_KEY,
      name: process.env.QWEN_MODEL || 'qwen-plus',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      label: `qwen:${process.env.QWEN_MODEL || 'qwen-plus'}`
    };
  }
  if (index === 2 && process.env.DEEPSEEK_API_KEY) {
    return {
      apiKey: process.env.DEEPSEEK_API_KEY,
      name: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      label: `deepseek:${process.env.DEEPSEEK_MODEL || 'deepseek-chat'}`
    };
  }
  return null;
}

function modelConfiguration() {
  const primary = configuredModel(1);
  if (!primary) {
    throw new Error('No primary model configured. Set PROFILE_MODEL_1_* or QWEN_API_KEY.');
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
