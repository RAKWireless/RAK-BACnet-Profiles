#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { ALLOWED_UNITS } = require('../units');

const OBJECT_TYPE = '(?:Analog|Binary|OctetString)(?:Input|Output|Value)?Object';
const OBJECT_TYPE_ALIASES = [
  ['octetstringvalueobject', 'OctetStringValueObject'],
  ['octetstringvalue', 'OctetStringValueObject'],
  ['octetstring', 'OctetStringValueObject'],
  ['analogoutputobject', 'AnalogOutputObject'],
  ['analoginputobject', 'AnalogInputObject'],
  ['analogvalueobject', 'AnalogValueObject'],
  ['binaryoutputobject', 'BinaryOutputObject'],
  ['binaryinputobject', 'BinaryInputObject'],
  ['binaryvalueobject', 'BinaryValueObject'],
  ['analogoutput', 'AnalogOutputObject'],
  ['analoginput', 'AnalogInputObject'],
  ['analogvalue', 'AnalogValueObject'],
  ['binaryoutput', 'BinaryOutputObject'],
  ['binaryinput', 'BinaryInputObject'],
  ['binaryvalue', 'BinaryValueObject'],
  ['ao', 'AnalogOutputObject'],
  ['ai', 'AnalogInputObject'],
  ['av', 'AnalogValueObject'],
  ['bo', 'BinaryOutputObject'],
  ['bi', 'BinaryInputObject'],
  ['bv', 'BinaryValueObject']
];

const UNIT_ALIASES = new Map([
  ['c', 'degreesCelsius'], ['degc', 'degreesCelsius'], ['celsius', 'degreesCelsius'],
  ['f', 'degreesFahrenheit'], ['degf', 'degreesFahrenheit'], ['fahrenheit', 'degreesFahrenheit'],
  ['k', 'degreesKelvin'], ['kelvin', 'degreesKelvin'],
  ['%', 'percent'], ['percentage', 'percent'],
  ['rh', 'percentRelativeHumidity'], ['%rh', 'percentRelativeHumidity'], ['relativehumidity', 'percentRelativeHumidity'],
  ['v', 'volts'], ['volt', 'volts'], ['voltage', 'volts'], ['mv', 'millivolts'], ['millivolt', 'millivolts'],
  ['uscm', 'microSiemens'], ['microsiemens', 'microSiemens'], ['mscm', 'millisiemens'], ['millisiemens', 'millisiemens'],
  ['ppm', 'partsPerMillion'], ['ppb', 'partsPerBillion'],
  ['pa', 'pascals'], ['hpa', 'hectopascals'], ['kpa', 'kilopascals'], ['mbar', 'millibars'], ['bar', 'bars'],
  ['lux', 'luxes'], ['lx', 'luxes'],
  ['m', 'meters'], ['meter', 'meters'], ['mm', 'millimeters'], ['millimeter', 'millimeters'], ['cm', 'centimeters'],
  ['l', 'liters'], ['liter', 'liters'], ['ml', 'milliliters'],
  ['s', 'seconds'], ['sec', 'seconds'], ['second', 'seconds'], ['min', 'minutes'], ['minute', 'minutes'], ['h', 'hours'], ['hour', 'hours'],
  ['w', 'watts'], ['kw', 'kilowatts'], ['mw', 'milliwatts'], ['wh', 'wattHours'], ['kwh', 'kilowattHours'],
  ['hz', 'hertz'], ['khz', 'kilohertz'], ['mhz', 'megahertz'],
  ['ph', 'pH'],
  ['unit', null], ['nounits', null], ['none', null], ['na', null]
]);

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeObjectType(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  for (const acronym of raw.matchAll(/\(([^)]+)\)/g)) {
    const key = acronym[1].toLowerCase().replace(/[^a-z]/g, '');
    const direct = OBJECT_TYPE_ALIASES.find(([alias]) => alias.length <= 3 && alias === key);
    if (direct) return direct[1];
  }
  const standaloneAcronym = raw.match(/(?:^|[^A-Za-z])(AI|AO|AV|BI|BO|BV)(?:[^A-Za-z]|$)/i);
  if (standaloneAcronym) {
    const direct = OBJECT_TYPE_ALIASES.find(([alias]) => alias === standaloneAcronym[1].toLowerCase());
    if (direct) return direct[1];
  }

  const normalized = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (!normalized) return null;
  for (const [alias, type] of OBJECT_TYPE_ALIASES) {
    if (normalized === alias) return type;
  }

  const supportedPrefix = raw.match(/^\s*(octet\s*string\s*value(?:\s*object)?|(?:analog|binary)\s*(?:input|output|value)(?:\s*object)?)(?=$|[^A-Za-z])/i);
  if (supportedPrefix) {
    const prefix = supportedPrefix[1].toLowerCase().replace(/[^a-z]/g, '');
    const direct = OBJECT_TYPE_ALIASES.find(([alias]) => alias === prefix);
    if (direct) return direct[1];
  }
  return null;
}

function normalizeUnit(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().replace(/[.,;]+$/, '');
  if (!raw) return null;
  if (ALLOWED_UNITS.has(raw)) return raw;
  const key = raw.toLowerCase()
    .replace(/[°℃]/g, '')
    .replace(/[µμ]/g, 'u')
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9%]/g, '');
  if (ALLOWED_UNITS.has(key)) return key;
  return UNIT_ALIASES.has(key) ? UNIT_ALIASES.get(key) : null;
}

function isNoUnitMarker(value) {
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return UNIT_ALIASES.has(key) && UNIT_ALIASES.get(key) === null;
}

function canonicalUnit(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const normalized = normalizeUnit(value);
  if (normalized !== null || isNoUnitMarker(value)) return normalized;
  return String(value).trim().replace(/[.,;]+$/, '');
}

function equivalentUnits(left, right) {
  if (left === right) return true;
  const normalizedLeft = normalizeUnit(left);
  const normalizedRight = normalizeUnit(right);
  if (normalizedLeft === null && normalizedRight === null) {
    const leftHasNoUnit = left === null || left === undefined || String(left).trim() === '' || isNoUnitMarker(left);
    const rightHasNoUnit = right === null || right === undefined || String(right).trim() === '' || isNoUnitMarker(right);
    return leftHasNoUnit && rightHasNoUnit;
  }
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function cleanMappingLine(line) {
  return String(line || '')
    .trim()
    .replace(/^\|\s*/, '')
    .replace(/\s*\|$/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .trim();
}

function splitLooseMapping(line) {
  const arrowOrTable = line.match(/^(.+?)\s*(?:→|->|[–—]\s*>|=>|\|)\s*(.+)$/);
  if (arrowOrTable) return [arrowOrTable[1].trim(), arrowOrTable[2].trim()];
  const colon = line.match(/^(.+?)\s*:\s*(.+)$/);
  if (colon) return [colon[1].trim(), colon[2].trim()];
  const spacedDash = line.match(/^(.+?)\s+[–—-]\s+(.+)$/);
  return spacedDash ? [spacedDash[1].trim(), spacedDash[2].trim()] : null;
}

function extractUnit(typeText) {
  const explicit = String(typeText || '').match(/\bunits?\s*[:=]\s*(.+)$/i);
  if (explicit) return canonicalUnit(explicit[1]);
  const parenthesized = [...String(typeText || '').matchAll(/\(([^)]+)\)/g)]
    .map(match => match[1].trim())
    .filter(value => !normalizeObjectType(value));
  return parenthesized.length > 0 ? canonicalUnit(parenthesized[parenthesized.length - 1]) : null;
}

function parseRequestedMappings(value) {
  return parseRequestedMappingDetails(value).mappings;
}

function unsupportedObjectType(line, loose) {
  if (!loose) return null;
  const hasExplicitMappingArrow = /(?:→|->|[–—]\s*>|=>|\|)/.test(line);
  const rawType = loose[1].trim();
  if (!hasExplicitMappingArrow && !/^(?:Analog|Binary|OctetString)[A-Za-z]+/i.test(rawType)) return null;
  const candidate = rawType.match(/^([A-Za-z][A-Za-z0-9]*)/);
  if (!candidate || !/(?:Analog|Binary|OctetString)/i.test(candidate[1])) return null;
  return {
    name: loose[0].trim(),
    type: candidate[1]
  };
}

function parseRequestedMappingDetails(value) {
  const mappings = [];
  const errors = [];
  const strictExpression = new RegExp(`^\\s*(.+?)\\s*(?:→|->|[–—]\\s*>|=>|\\||:|-)\\s*(${OBJECT_TYPE})(?:\\s*\\(([^)]+)\\))?\\s*$`, 'i');
  for (const rawLine of String(value || '').split(/\r?\n/)) {
    if (/parameter name|bacnet object type/i.test(rawLine)) continue;
    const line = cleanMappingLine(rawLine);
    if (!line) continue;

    const strict = line.match(strictExpression);
    if (strict) {
      mappings.push({
        name: strict[1].trim(),
        type: normalizeObjectType(strict[2]),
        units: strict[3] ? canonicalUnit(strict[3]) : null
      });
      continue;
    }

    const loose = splitLooseMapping(line);
    if (!loose) continue;
    const resolvedType = normalizeObjectType(loose[1]);
    if (!resolvedType) {
      const unsupported = unsupportedObjectType(line, loose);
      if (unsupported) {
        errors.push(`Unsupported BACnet object type '${unsupported.type}' for '${unsupported.name}'`);
      }
      continue;
    }
    mappings.push({
      name: loose[0].trim(),
      type: resolvedType,
      units: extractUnit(loose[1]),
      rawType: loose[1].trim()
    });
  }
  return { mappings, errors };
}

function extractMappingReferences(value) {
  const references = [];
  for (const rawLine of String(value || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /parameter name|bacnet object type/i.test(line)) continue;
    const refersToDocument = /\b(?:refer(?:ence)?|see|according)\b/i.test(line) && /\b(?:document|manual|datasheet|specification)\b/i.test(line);
    const page = line.match(/\bpages?\s*[:#]?\s*(\d+(?:\s*[-–—]\s*\d+)?)/i);
    if (!refersToDocument || !page) continue;
    references.push({
      type: 'official-document',
      pages: page[1].replace(/\s*[–—]\s*/g, '-').replace(/\s+/g, ''),
      citation: line
    });
  }
  return references;
}

function analyzeRequestedMappings(value) {
  const parsed = parseRequestedMappingDetails(value);
  if (parsed.errors.length > 0) {
    return { status: 'invalid', mappings: parsed.mappings, references: [], errors: parsed.errors };
  }
  if (parsed.mappings.length > 0) return { status: 'explicit', mappings: parsed.mappings, references: [], errors: [] };
  const references = extractMappingReferences(value);
  if (references.length > 0) return { status: 'deferred', mappings: [], references, errors: [] };
  return { status: 'missing', mappings: [], references: [], errors: [] };
}

function normalizeMappingEntries(entries) {
  const mappings = [];
  const errors = [];
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const name = String(entry && entry.name || '').trim();
    const type = normalizeObjectType(entry && entry.type);
    const rawUnits = entry && entry.units;
    const units = normalizeUnit(rawUnits);
    const citation = String(entry && entry.citation || '').trim();
    if (!name || !type || !citation) {
      errors.push(`Extracted BACnet mapping ${index + 1} must include name, supported object type, and citation`);
      continue;
    }
    if (rawUnits !== null && rawUnits !== undefined && String(rawUnits).trim() && units === null && !isNoUnitMarker(rawUnits)) {
      errors.push(`Extracted BACnet mapping ${index + 1} uses unsupported units '${rawUnits}'`);
      continue;
    }
    mappings.push({ name, type, units, citation });
  }
  return { valid: errors.length === 0 && mappings.length > 0, mappings, errors };
}

function formatRequestedMappings(mappings) {
  return (mappings || []).map(mapping => {
    const units = mapping.units ? ` (${mapping.units})` : '';
    return `- ${mapping.name} → ${mapping.type}${units}`;
  }).join('\n');
}

function findDatatypeEntry(profile, requestedName) {
  const requested = normalize(requestedName);
  return Object.values(profile.datatype || {}).find(config => {
    if (!config || typeof config !== 'object') return false;
    const actual = normalize(config.name);
    return Boolean(actual && requested && actual === requested);
  });
}

function validateRequestedMapping(profile, mappingText) {
  const errors = [];
  const warnings = [];
  const requested = parseRequestedMappings(mappingText);
  if (requested.length === 0) {
    return { valid: false, errors: ['No resolved machine-readable BACnet mapping rows were found'], warnings, requested };
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
    if (mapping.units && !equivalentUnits(config.units, mapping.units)) {
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

module.exports = {
  parseRequestedMappings,
  analyzeRequestedMappings,
  extractMappingReferences,
  normalizeMappingEntries,
  formatRequestedMappings,
  normalizeObjectType,
  normalizeUnit,
  equivalentUnits,
  validateRequestedMapping
};
