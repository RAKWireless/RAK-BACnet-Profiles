'use strict';

function safeValue(value) {
  return String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 200);
}

function logProgress(stage, message, details = {}) {
  const fields = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${safeValue(value)}`);
  const suffix = fields.length > 0 ? ` ${fields.join(' ')}` : '';
  console.log(`[profile-automation] ${new Date().toISOString()} [${stage}] ${message}${suffix}`);
}

function elapsedSeconds(startedAt) {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

module.exports = { logProgress, elapsedSeconds };
