#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadYAML } = require('../yaml-parser');

const mappingRules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schemas', 'bacnet-mapping-rules.json'), 'utf8'));
const OUTPUT_TYPES = new Set(['AnalogOutputObject', 'BinaryOutputObject']);

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
}

function matchingRule(name) {
  const normalized = normalize(name);
  const matches = mappingRules.rules.flatMap((rule, index) => {
    const keywordLengths = rule.keywords
      .map(keyword => normalize(keyword))
      .filter(keyword => keyword && normalized.includes(keyword))
      .map(keyword => keyword.length);
    if (keywordLengths.length === 0) return [];
    return [{ rule, index, keywordLength: Math.max(...keywordLengths) }];
  });
  matches.sort((left, right) => (
    (right.rule.priority || 0) - (left.rule.priority || 0) ||
    right.keywordLength - left.keywordLength ||
    left.index - right.index
  ));
  return matches.length > 0 ? matches[0].rule : null;
}

function validateProfileSemantics(profile, filePath, options = {}) {
  const strict = options.strict !== false;
  const errors = [];
  const warnings = [];
  const channels = Object.entries(profile.datatype || {});
  const names = new Set();

  if (channels.length === 0) errors.push('datatype must declare at least one BACnet object');
  if (strict && profile.profileVersion !== '1.0.0') errors.push('New profiles must start at profileVersion 1.0.0');
  if (strict && !isUuid(profile.id)) errors.push('New profiles must contain a generated UUID v4 id');
  if (!profile.vendor || !/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(profile.vendor)) errors.push('vendor must be an English identifier');
  if (!profile.name || !/^[\x20-\x7E]+$/.test(profile.name)) errors.push('name must use printable English characters');

  if (filePath) {
    const basename = path.basename(filePath, path.extname(filePath));
    const parentVendor = path.basename(path.dirname(filePath));
    if (profile.model !== basename) errors.push(`model '${profile.model}' must match filename '${basename}'`);
    if (profile.vendor !== parentVendor) errors.push(`vendor '${profile.vendor}' must match directory '${parentVendor}'`);
  }

  if (/function\s+(?:Encode|encodeDownlink)\b|\b(?:Encode|encodeDownlink)\s*=/.test(profile.codec || '')) {
    errors.push('Profile Automation only accepts uplink-only codecs');
  }

  for (const [channelKey, config] of channels) {
    const channel = Number(channelKey);
    if (!Number.isInteger(channel) || channel < 1) errors.push(`datatype.${channelKey}: channel key must be a positive integer`);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      errors.push(`datatype.${channelKey}: configuration must be an object`);
      continue;
    }
    if (config.channel !== undefined && config.channel !== channel) {
      errors.push(`datatype.${channelKey}: channel property must equal ${channel}`);
    }
    if (!config.name || !/^[\x20-\x7E]+$/.test(config.name)) errors.push(`datatype.${channelKey}: name must be English`);
    const normalizedName = normalize(config.name);
    if (names.has(normalizedName)) errors.push(`datatype.${channelKey}: duplicate object name '${config.name}'`);
    names.add(normalizedName);

    if (OUTPUT_TYPES.has(config.type) || Object.prototype.hasOwnProperty.call(config, 'fport')) {
      errors.push(`datatype.${channelKey}: downlink-capable objects are not supported by Profile Automation`);
    }
    if (config.type === 'BinaryInputObject' && config.units != null) {
      errors.push(`datatype.${channelKey}: BinaryInputObject must not define units`);
    }
    if (config.updateInterval !== undefined && (!Number.isInteger(config.updateInterval) || config.updateInterval < 0 || config.updateInterval > 86400)) {
      errors.push(`datatype.${channelKey}: updateInterval must be between 0 and 86400 seconds`);
    }
    if (config.covIncrement !== undefined && (!Number.isFinite(config.covIncrement) || config.covIncrement < 0)) {
      errors.push(`datatype.${channelKey}: covIncrement must be a non-negative number`);
    }

    const rule = matchingRule(config.name);
    if (rule) {
      if (!rule.types.includes(config.type)) errors.push(`datatype.${channelKey}: '${config.name}' should use one of: ${rule.types.join(', ')}`);
      if (rule.units.length > 0 && !rule.units.includes(config.units)) {
        errors.push(`datatype.${channelKey}: '${config.name}' should use one of these units: ${rule.units.join(', ')}`);
      }
    } else {
      warnings.push(`datatype.${channelKey}: no BACnet mapping rule matched '${config.name}'`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateDecodedData(profile, decodedData) {
  const errors = [];
  const data = Array.isArray(decodedData) ? decodedData : [];
  const seenChannels = new Set();

  for (const item of data) {
    if (!item || typeof item !== 'object') {
      errors.push('Decoded data entries must be objects');
      continue;
    }
    if (!Number.isInteger(item.channel) || item.channel < 1) {
      errors.push(`Decoded entry '${item.name || 'unknown'}' has an invalid channel`);
      continue;
    }
    if (seenChannels.has(item.channel)) errors.push(`Decoded output contains duplicate channel ${item.channel}`);
    seenChannels.add(item.channel);

    const mapping = profile.datatype && profile.datatype[String(item.channel)];
    if (!mapping) {
      errors.push(`Decoded channel ${item.channel} is not declared in datatype`);
      continue;
    }
    if (item.name !== mapping.name) errors.push(`Channel ${item.channel} name '${item.name}' does not match datatype name '${mapping.name}'`);
    const expectedUnit = mapping.units === undefined ? null : mapping.units;
    const actualUnit = item.unit === undefined ? null : item.unit;
    if (actualUnit !== expectedUnit) errors.push(`Channel ${item.channel} unit '${actualUnit}' does not match datatype unit '${expectedUnit}'`);
    if (typeof item.value === 'number' && !Number.isFinite(item.value)) errors.push(`Channel ${item.channel} value must be finite`);
    if (item.value === undefined) errors.push(`Channel ${item.channel} value is undefined`);
  }

  return { valid: errors.length === 0, errors, channels: [...seenChannels] };
}

function main() {
  const profilePath = process.argv[2];
  if (!profilePath) {
    console.error('Usage: node scripts/lib/validation/profile-semantics.js <profile.yaml> [--json]');
    process.exit(2);
  }
  const report = validateProfileSemantics(loadYAML(profilePath), profilePath, { strict: true });
  console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : (report.valid ? 'Profile semantics: PASS' : `Profile semantics: FAIL\n${report.errors.join('\n')}`));
  process.exit(report.valid ? 0 : 1);
}

if (require.main === module) main();

module.exports = { validateProfileSemantics, validateDecodedData };
