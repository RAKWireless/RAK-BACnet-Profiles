'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WORKSPACE_ROOT } = require('./config');
const { scrubPII } = require('./pii-scrubber');
const { analyzeRequestedMappings } = require('../../scripts/lib/validation/requested-mapping');

const FIELD_LABELS = {
  vendor: 'Device Vendor',
  model: 'Device Model',
  datasheet: 'Product Manual/Datasheet Link',
  lorawanClass: 'LoRaWAN Class',
  lorawanVersion: 'LoRaWAN Protocol Version',
  uplinkData: 'Uplink Data Examples',
  decoder: 'Decode Function (Optional)',
  downlinkSupport: 'Downlink Support',
  downlinkCommands: 'Downlink Command Examples (Only if Downlink Support is Yes)',
  bacnetMapping: 'BACnet Object Mapping Requirements'
};

function stripFence(value) {
  return String(value || '')
    .trim()
    .replace(/^```[^\n]*\n/, '')
    .replace(/\n```$/, '')
    .trim();
}

function parseSections(body) {
  const sections = {};
  const text = String(body || '').replace(/<!--[\s\S]*?-->/g, '');
  const expression = /^###\s+(.+?)\s*$/gm;
  const headings = [];
  let match;
  while ((match = expression.exec(text)) !== null) {
    headings.push({ label: match[1].trim(), start: match.index, contentStart: expression.lastIndex });
  }
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const end = index + 1 < headings.length ? headings[index + 1].start : text.length;
    sections[heading.label] = stripFence(text.slice(heading.contentStart, end));
  }
  return sections;
}

function safeSlug(value, label) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 -]/g, '')
    .trim()
    .replace(/[ ]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) throw new Error(`${label} must contain ASCII letters or numbers`);
  return slug;
}

function normalizeHex(value) {
  return String(value || '').replace(/0x/gi, '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
}

const PORT_EXPRESSION = /(?:f\s*port|\bport)\s*[:=]?\s*(\d{1,3})\s*[:=]?/i;

function normalizeMarkdownLine(value) {
  return String(value || '').replace(/[*_`~]/g, ' ');
}

function extractUplinkExamples(value) {
  const examples = [];
  const lines = String(value || '').split(/\r?\n/);
  const declaredPorts = new Set();
  for (const line of lines) {
    const match = normalizeMarkdownLine(line).match(PORT_EXPRESSION);
    if (match) declaredPorts.add(Number(match[1]));
  }
  let currentPort = null;
  for (const line of lines) {
    const normalizedLine = normalizeMarkdownLine(line);
    const portMatch = normalizedLine.match(PORT_EXPRESSION);
    if (portMatch) currentPort = Number(portMatch[1]);
    const assignedPort = currentPort === null && declaredPorts.size === 1
      ? [...declaredPorts][0]
      : currentPort;
    const payloadLine = normalizedLine.replace(PORT_EXPRESSION, ' ');
    const spaced = payloadLine.match(/(?:\b[0-9A-Fa-f]{2}[\s:-]+){1,}[0-9A-Fa-f]{2}\b/g) || [];
    const compact = payloadLine.match(/\b[0-9A-Fa-f]{4,}\b/g) || [];
    for (const candidate of [...spaced, ...compact]) {
      const hex = normalizeHex(candidate);
      const byteLength = hex.length / 2;
      const pureHexLine = /^\s*(?:(?:0x)?[0-9A-Fa-f]{2}[\s:-]*){2,}\s*$/.test(normalizedLine);
      const looksLikeExample = Boolean(portMatch) || pureHexLine || /example|payload|uplink|hex|bytes?|пример|示例|例/i.test(line) || byteLength >= 6;
      if (looksLikeExample && hex.length >= 4 && hex.length % 2 === 0 && !examples.some(item => item.hex === hex && item.fPort === assignedPort)) {
        examples.push({
          fPort: assignedPort,
          explicitFPort: Number.isInteger(assignedPort),
          hex,
          sourceLine: scrubPII(line.trim())
        });
      }
    }
  }
  return examples;
}

function numericControlValue(value) {
  const raw = String(value || '').trim();
  if (/^0x[0-9a-f]+$/i.test(raw)) return parseInt(raw.slice(2), 16);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyDownlinkExample() {
  return {
    command: null,
    bacnetObject: null,
    fPort: null,
    value: null,
    hex: null,
    allowedValues: null,
    expectedResponse: null,
    reference: null
  };
}

function extractDownlinkExamples(value) {
  const examples = [];
  const errors = [];
  let current = emptyDownlinkExample();

  function hasContent(example) {
    return Object.values(example).some(item => item !== null && item !== '');
  }

  function finish() {
    if (!hasContent(current)) return;
    const normalized = {
      ...current,
      complete: Boolean(
        current.command &&
        Number.isInteger(current.fPort) &&
        typeof current.value === 'number' &&
        Number.isFinite(current.value) &&
        current.hex
      )
    };
    const duplicate = examples.some(example => (
      example.command === normalized.command &&
      example.fPort === normalized.fPort &&
      example.value === normalized.value &&
      example.hex === normalized.hex
    ));
    if (!duplicate) examples.push(normalized);
    current = emptyDownlinkExample();
  }

  for (const rawLine of String(value || '').split(/\r?\n/)) {
    const line = normalizeMarkdownLine(rawLine).trim().replace(/^[-+]\s+/, '');
    if (!line) {
      finish();
      continue;
    }

    let match = line.match(/^(?:command(?:\s+name)?|downlink\s+command)\s*[:=]\s*(.+)$/i);
    if (match) {
      if (hasContent(current)) finish();
      current.command = scrubPII(match[1].trim());
      continue;
    }
    match = line.match(/^bacnet\s+object\s*[:=]\s*(.+)$/i);
    if (match) {
      current.bacnetObject = scrubPII(match[1].trim());
      continue;
    }
    match = line.match(/^(?:f\s*port|port)\s*[:=]\s*(-?\d{1,3})\s*$/i);
    if (match) {
      current.fPort = Number(match[1]);
      continue;
    }
    match = line.match(/^control\s+value\s*[:=]\s*(.+)$/i);
    if (match) {
      current.value = numericControlValue(match[1]);
      if (current.value === null) errors.push(`Downlink control value must be numeric: ${scrubPII(match[1].trim())}`);
      continue;
    }
    match = line.match(/^(?:expected\s+)?downlink\s+payload\s*[:=]\s*(.+)$/i);
    if (match) {
      const hex = normalizeHex(match[1]);
      if (!hex || hex.length % 2 !== 0) errors.push(`Downlink payload must contain complete hexadecimal bytes: ${scrubPII(match[1].trim())}`);
      else current.hex = hex;
      continue;
    }
    match = line.match(/^allowed\s+values?(?:\s+or\s+range)?\s*[:=]\s*(.+)$/i);
    if (match) {
      current.allowedValues = scrubPII(match[1].trim());
      continue;
    }
    match = line.match(/^expected\s+(?:device\s+)?(?:response(?:\s*\/\s*ack)?|ack)\s*[:=]\s*(.+)$/i);
    if (match) {
      current.expectedResponse = scrubPII(match[1].trim());
      continue;
    }
    match = line.match(/^(?:reference|reference\s+or\s+verification\s+source|verification\s+source)\s*[:=]\s*(.+)$/i);
    if (match) {
      current.reference = scrubPII(match[1].trim());
      continue;
    }

    if (!current.command) current.command = scrubPII(line.replace(/[:：]\s*$/, ''));
  }
  finish();
  return { examples, errors };
}

function field(sections, key) {
  return sections[FIELD_LABELS[key]] || '';
}

function parseIssue(issue, options = {}) {
  const errors = [];
  const warnings = [];
  const sections = parseSections(issue.body || '');
  const hasProfileRequestTitle = /^\[Profile Request\]/i.test(issue.title || '');
  const hasProfileIdentitySections = Object.prototype.hasOwnProperty.call(sections, FIELD_LABELS.vendor)
    && Object.prototype.hasOwnProperty.call(sections, FIELD_LABELS.model);
  if (!hasProfileRequestTitle && !hasProfileIdentitySections) {
    return {
      status: 'ignored',
      errors: ['Issue title is not a Profile Request'],
      warnings,
      issueNumber: issue.number,
      issueBodySha: crypto.createHash('sha256').update(String(issue.body || '')).digest('hex')
    };
  }
  if (!hasProfileRequestTitle) {
    warnings.push('Issue title does not use the recommended [Profile Request] prefix; Device Vendor and Device Model from the Issue body were used');
  }

  let vendor;
  let model;
  try {
    vendor = safeSlug(field(sections, 'vendor'), 'Device Vendor');
    model = safeSlug(field(sections, 'model'), 'Device Model');
  } catch (error) {
    errors.push(error.message);
  }
  const profileName = vendor && model ? `${vendor}-${model}` : null;
  const datasheet = field(sections, 'datasheet');
  let datasheetUrl = null;
  try {
    const parsed = new URL(datasheet);
    if (parsed.protocol !== 'https:') throw new Error('Datasheet URL must use HTTPS');
    datasheetUrl = parsed.toString();
  } catch (error) {
    errors.push(`Product Manual/Datasheet Link is invalid: ${error.message}`);
  }

  const uplinkExamples = extractUplinkExamples(field(sections, 'uplinkData'));
  if (uplinkExamples.length === 0) errors.push('At least one hexadecimal uplink example is required');
  if (uplinkExamples.length > 20) errors.push('At most 20 uplink examples can be processed automatically');
  if (uplinkExamples.some(example => example.hex.length / 2 > 255)) {
    errors.push('Uplink examples must not exceed 255 bytes');
  }
  const fPortStatus = uplinkExamples.some(example => !Number.isInteger(example.fPort)) ? 'deferred' : 'explicit';
  if (fPortStatus === 'deferred') {
    warnings.push('One or more uplink examples omit fPort; evidence must prove fixed/agnostic behavior or select payload-driven ignored mode without guessing a device port');
  }
  if (uplinkExamples.some(example => Number.isInteger(example.fPort) && (example.fPort < 1 || example.fPort > 254))) {
    errors.push('Every uplink fPort must be between 1 and 254');
  }
  const lorawanClass = field(sections, 'lorawanClass');
  if (!['Class A', 'Class B', 'Class C'].includes(lorawanClass)) {
    errors.push('LoRaWAN Class must be selected from the Issue form');
  }
  const lorawanVersion = field(sections, 'lorawanVersion');
  if (!['LORAWAN_1_0_2', 'LORAWAN_1_0_3', 'LORAWAN_1_0_4'].includes(lorawanVersion)) {
    errors.push('LoRaWAN Protocol Version must be selected from the Issue form');
  }
  const bacnetMapping = field(sections, 'bacnetMapping');
  const bacnetMappingRequest = analyzeRequestedMappings(bacnetMapping);
  if (bacnetMappingRequest.status === 'missing') {
    errors.push('BACnet Object Mapping Requirements must contain mapping rows or an explicit official-document page reference');
  } else if (bacnetMappingRequest.status === 'invalid') {
    errors.push(...bacnetMappingRequest.errors);
  } else if (bacnetMappingRequest.status === 'deferred') {
    warnings.push('BACnet mappings will be extracted from the cited official-document pages before generation');
  }

  const downlinkSupport = field(sections, 'downlinkSupport');
  const supportsDownlink = /^Yes\s*-?\s*supports downlink commands/i.test(downlinkSupport);
  const isUplinkOnly = /^No\s*-?\s*uplink only/i.test(downlinkSupport);
  const downlinkText = field(sections, 'downlinkCommands');
  const downlinkExtraction = extractDownlinkExamples(downlinkText);
  const downlinkExamples = downlinkExtraction.examples;
  errors.push(...downlinkExtraction.errors);
  if (downlinkExamples.length > 20) errors.push('At most 20 downlink examples can be processed automatically');
  if (downlinkExamples.some(example => example.hex && example.hex.length / 2 > 255)) {
    errors.push('Downlink examples must not exceed 255 bytes');
  }
  if (downlinkExamples.some(example => Number.isInteger(example.fPort) && (example.fPort < 1 || example.fPort > 254))) {
    errors.push('Every downlink fPort must be between 1 and 254');
  }
  const completeDownlinkExamples = downlinkExamples.filter(example => example.complete);
  const downlinkEvidenceStatus = !supportsDownlink
    ? 'not-requested'
    : (completeDownlinkExamples.length > 0 ? 'explicit' : 'deferred');
  if (supportsDownlink && downlinkEvidenceStatus === 'deferred') {
    warnings.push('Downlink known-answer examples are incomplete or absent; the official document must fully specify each requested command, fPort, numeric value encoding, and payload format');
  }
  if (isUplinkOnly && downlinkExamples.length > 0) {
    warnings.push('Downlink examples were provided while Downlink Support is set to uplink only');
  }
  const manualReasons = [];
  let status = errors.length > 0 ? 'needs-info' : 'ready';
  if (!supportsDownlink && !isUplinkOnly) {
    status = 'manual';
    manualReasons.push('Downlink support must be confirmed as Yes or No before Profile Automation can run');
  }

  const profilePath = profileName ? path.join(WORKSPACE_ROOT, 'profiles', vendor, `${profileName}.yaml`) : null;
  if (status === 'ready' && profilePath && fs.existsSync(profilePath) && !options.allowExisting) {
    return {
      status: 'duplicate',
      errors: [`Profile already exists: profiles/${vendor}/${profileName}.yaml`],
      warnings,
      issueNumber: issue.number,
      profileName,
      issueBodySha: crypto.createHash('sha256').update(String(issue.body || '')).digest('hex'),
      authorAssociation: issue.author_association || 'NONE'
    };
  }

  return {
    status,
    errors,
    warnings,
    issueNumber: issue.number,
    issueUrl: issue.html_url || issue.url,
    issueBodySha: crypto.createHash('sha256').update(String(issue.body || '')).digest('hex'),
    issueUpdatedAt: issue.updated_at || null,
    authorAssociation: issue.author_association || 'NONE',
    title: scrubPII(issue.title || ''),
    vendor,
    model,
    profileName,
    datasheetUrl,
    lorawanClass,
    lorawanVersion,
    fPortStatus,
    uplinkText: scrubPII(field(sections, 'uplinkData')),
    uplinkExamples,
    decoder: scrubPII(field(sections, 'decoder')),
    downlinkSupport,
    downlinkEvidenceStatus,
    downlinkText: scrubPII(downlinkText),
    downlinkExamples,
    manualReasons,
    bacnetMapping: scrubPII(bacnetMapping),
    bacnetMappingStatus: bacnetMappingRequest.status,
    bacnetMappingReferences: bacnetMappingRequest.references,
    requestedMappings: bacnetMappingRequest.mappings
  };
}

module.exports = { FIELD_LABELS, parseSections, parseIssue, extractUplinkExamples, extractDownlinkExamples, normalizeHex };
