#!/usr/bin/env node
'use strict';

const fs = require('fs');

const OBJECT_TYPE = '(?:Analog|Binary|OctetString)(?:Input|Output|Value)?Object';

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseRequestedMappings(value) {
  const mappings = [];
  const expression = new RegExp(`^\\s*[-*]?\\s*(.+?)\\s*(?:→|->|\\||:|-)\\s*(${OBJECT_TYPE})(?:\\s*\\(([^)]+)\\))?`, 'i');
  for (const line of String(value || '').split(/\r?\n/)) {
    if (/parameter name/i.test(line)) continue;
    const match = line.match(expression);
    if (!match) continue;
    mappings.push({ name: match[1].trim(), type: match[2], units: match[3] ? match[3].trim() : null });
  }
  return mappings;
}

function findDatatypeEntry(profile, requestedName) {
  const requested = normalize(requestedName);
  return Object.values(profile.datatype || {}).find(config => {
    if (!config || typeof config !== 'object') return false;
    const actual = normalize(config.name);
    return Boolean(actual && requested && (actual === requested || actual.includes(requested) || requested.includes(actual)));
  });
}

function validateRequestedMapping(profile, mappingText) {
  const errors = [];
  const warnings = [];
  const requested = parseRequestedMappings(mappingText);
  if (requested.length === 0) {
    return { valid: false, errors: ['No machine-readable BACnet mapping rows were found in the Issue'], warnings, requested };
  }
  for (const mapping of requested) {
    const config = findDatatypeEntry(profile, mapping.name);
    if (!config) {
      errors.push(`Requested BACnet parameter '${mapping.name}' is missing from datatype`);
      continue;
    }
    if (String(config.type).toLowerCase() !== mapping.type.toLowerCase()) {
      errors.push(`Requested BACnet parameter '${mapping.name}' must use ${mapping.type}, not ${config.type}`);
    }
    if (mapping.units && normalize(mapping.units) !== 'unit' && config.units !== mapping.units) {
      errors.push(`Requested BACnet parameter '${mapping.name}' must use units '${mapping.units}', not '${config.units ?? 'null'}'`);
    }
  }
  return { valid: errors.length === 0, errors, warnings, requested };
}

function main() {
  const { loadYAML } = require('../yaml-parser');
  const profilePath = process.argv[2];
  const mappingPath = process.argv[3];
  if (!profilePath || !mappingPath) {
    console.error('Usage: node scripts/lib/validation/requested-mapping.js <profile.yaml> <mapping.txt> [--json]');
    process.exit(2);
  }
  const report = validateRequestedMapping(loadYAML(profilePath), fs.readFileSync(mappingPath, 'utf8'));
  console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : (report.valid ? 'Requested BACnet mapping: PASS' : `Requested BACnet mapping: FAIL\n${report.errors.join('\n')}`));
  process.exit(report.valid ? 0 : 1);
}

if (require.main === module) main();

module.exports = { parseRequestedMappings, validateRequestedMapping };
