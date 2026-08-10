'use strict';

function scrubPII(value) {
  return String(value || '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email removed]')
    .replace(/(^|\n)(?:email|contact|company|organization)\s*:\s*[^\n]*/gi, '$1[contact removed]');
}

module.exports = { scrubPII };
