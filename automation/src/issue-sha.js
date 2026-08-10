'use strict';

function issueShaError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeCollectionExpectedSha(value) {
  const expectedSha = String(value || '').trim().toLowerCase();
  if (!expectedSha || expectedSha === 'current') return '';
  if (!/^[a-f0-9]{64}$/.test(expectedSha)) {
    throw issueShaError('Expected Issue body SHA must be "current" or a 64-character SHA-256 value', 'INVALID_EXPECTED_SHA');
  }
  return expectedSha;
}

function assertCollectionIssueSha(actualSha, expectedValue) {
  const expectedSha = normalizeCollectionExpectedSha(expectedValue);
  if (expectedSha && String(actualSha) !== expectedSha) {
    throw issueShaError('Issue body changed after this run was queued', 'ISSUE_SHA_MISMATCH');
  }
  return expectedSha;
}

module.exports = { normalizeCollectionExpectedSha, assertCollectionIssueSha };
