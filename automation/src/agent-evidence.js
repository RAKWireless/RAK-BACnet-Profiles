'use strict';

const fs = require('fs');
const path = require('path');
const { readJson } = require('./io');

const MAX_EVIDENCE_LINES = 120;
const MAX_EVIDENCE_CHARS = 8192;
const MAX_SEARCH_MATCHES = 8;
const MAX_SEARCH_CONTEXT = 4;

const SOURCE_NAMES = new Set([
  'request',
  'official-document',
  'decoder',
  'validation-report',
  'previous-profile',
  'previous-fixture'
]);

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function regularFile(filePath, source) {
  if (!fs.existsSync(filePath)) throw new Error(`Prepared evidence source is unavailable: ${source}`);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Prepared evidence source must be a regular file: ${source}`);
  return filePath;
}

function resolveEvidencePath(requestPath, source) {
  if (!SOURCE_NAMES.has(source)) throw new Error(`Unsupported prepared evidence source: ${source}`);
  const absoluteRequest = path.resolve(requestPath);
  const inputRoot = path.dirname(absoluteRequest);
  const request = readJson(absoluteRequest);
  let target;

  if (source === 'request') target = absoluteRequest;
  else if (source === 'official-document') target = path.join(inputRoot, 'official-document.txt');
  else if (source === 'decoder') target = path.join(inputRoot, 'decoder.txt');
  else if (source === 'validation-report') target = path.join(inputRoot, 'validation-report.json');
  else if (source === 'previous-profile') target = path.join(inputRoot, 'previous', request.execution.profilePath);
  else target = path.join(inputRoot, 'previous', request.execution.fixturePath);

  const absoluteTarget = path.resolve(target);
  if (!inside(inputRoot, absoluteTarget)) throw new Error(`Prepared evidence source escapes the input directory: ${source}`);
  return regularFile(absoluteTarget, source);
}

function positiveInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function pageNumbers(lines) {
  const pages = [];
  for (const line of lines) {
    const match = line.match(/^--- Page (\d+) ---$/);
    if (match) pages.push(Number(match[1]));
  }
  return pages;
}

function lineRange(value, lineCount) {
  const match = String(value || '').match(/^(\d+):(\d+)$/);
  if (!match) throw new Error('lines must use start:end with 1-based line numbers');
  const start = positiveInteger(match[1], 'line start', 1, Math.max(1, lineCount));
  const requestedEnd = positiveInteger(match[2], 'line end', start, Number.MAX_SAFE_INTEGER);
  const availableEnd = Math.min(requestedEnd, lineCount);
  const end = Math.min(availableEnd, start + MAX_EVIDENCE_LINES - 1);
  return { start, end, truncated: end < availableEnd };
}

function selectedIndexes(lines, options) {
  const selectors = [options.index, options.page !== undefined, options.search !== undefined, options.lines !== undefined].filter(Boolean);
  if (selectors.length !== 1) throw new Error('Select exactly one of --index, --page, --search, or --lines');
  if (options.index) return { selection: { type: 'index' }, indexes: [], truncated: false };

  if (options.page !== undefined) {
    const page = positiveInteger(options.page, 'page', 1, 100000);
    const start = lines.findIndex(line => line === `--- Page ${page} ---`);
    if (start < 0) throw new Error(`Prepared evidence does not contain Page ${page}`);
    let end = lines.findIndex((line, index) => index > start && /^--- Page \d+ ---$/.test(line));
    if (end < 0) end = lines.length;
    const requested = Array.from({ length: end - start }, (_, index) => start + index);
    return {
      selection: { type: 'page', page },
      indexes: requested.slice(0, MAX_EVIDENCE_LINES),
      truncated: requested.length > MAX_EVIDENCE_LINES
    };
  }

  if (options.search !== undefined) {
    const search = String(options.search || '').trim();
    if (search.length < 2 || search.length > 80 || /[\r\n]/.test(search)) {
      throw new Error('search must contain 2-80 characters on one line');
    }
    const context = options.context === undefined
      ? 2
      : positiveInteger(options.context, 'context', 0, MAX_SEARCH_CONTEXT);
    const matches = [];
    const needle = search.toLowerCase();
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].toLowerCase().includes(needle)) matches.push(index);
    }
    const selected = new Set();
    for (const match of matches.slice(0, MAX_SEARCH_MATCHES)) {
      for (let index = Math.max(0, match - context); index <= Math.min(lines.length - 1, match + context); index += 1) {
        selected.add(index);
      }
    }
    const indexes = [...selected].sort((left, right) => left - right).slice(0, MAX_EVIDENCE_LINES);
    return {
      selection: { type: 'search', search, context, matches: matches.length },
      indexes,
      truncated: matches.length > MAX_SEARCH_MATCHES || selected.size > MAX_EVIDENCE_LINES
    };
  }

  const range = lineRange(options.lines, lines.length);
  return {
    selection: { type: 'lines', start: range.start, end: range.end },
    indexes: Array.from({ length: range.end - range.start + 1 }, (_, index) => range.start - 1 + index),
    truncated: range.truncated
  };
}

function boundedLines(lines, indexes, initiallyTruncated) {
  const output = [];
  let characters = 0;
  let truncated = initiallyTruncated;
  for (const index of indexes) {
    const text = lines[index];
    const cost = text.length + 16;
    if (output.length >= MAX_EVIDENCE_LINES || characters + cost > MAX_EVIDENCE_CHARS) {
      truncated = true;
      break;
    }
    output.push({ number: index + 1, text });
    characters += cost;
  }
  return { lines: output, truncated };
}

function readAgentEvidence(requestPath, options = {}) {
  const source = String(options.source || '');
  const filePath = resolveEvidencePath(requestPath, source);
  const text = fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const selected = selectedIndexes(lines, options);
  const bounded = boundedLines(lines, selected.indexes, selected.truncated);
  return {
    schemaVersion: 1,
    source,
    selection: selected.selection,
    totalLines: lines.length,
    totalCharacters: text.length,
    pages: pageNumbers(lines),
    limits: {
      maxLines: MAX_EVIDENCE_LINES,
      maxCharacters: MAX_EVIDENCE_CHARS,
      maxSearchMatches: MAX_SEARCH_MATCHES
    },
    truncated: bounded.truncated,
    lines: bounded.lines
  };
}

module.exports = {
  MAX_EVIDENCE_LINES,
  MAX_EVIDENCE_CHARS,
  MAX_SEARCH_MATCHES,
  readAgentEvidence
};
