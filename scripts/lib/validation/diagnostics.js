'use strict';

const SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 6,
  maxArrayItems: 32,
  maxObjectKeys: 32,
  maxStringLength: 512,
  maxBytes: 8 * 1024
});

function diagnosticValue(value) {
  if (value === undefined) return { kind: 'undefined' };
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { kind: 'non-finite-number', value: String(value) };
  }
  if (typeof value === 'bigint') return { kind: 'bigint', value: value.toString() };
  if (typeof value === 'function' || typeof value === 'symbol') return { kind: typeof value };
  return value;
}

function differenceValue(value) {
  return boundedSnapshot(value, {
    maxDepth: 3,
    maxArrayItems: 16,
    maxObjectKeys: 16,
    maxStringLength: 256,
    maxBytes: 2 * 1024
  }).value;
}

function appendPath(base, key, isArray = false) {
  if (isArray) return `${base}[${key}]`;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return base ? `${base}.${key}` : key;
  return `${base}[${JSON.stringify(key)}]`;
}

function firstDifference(expected, actual, path = '') {
  if (Object.is(expected, actual)) return null;
  if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object') {
    return { path: path || '$', expected: differenceValue(expected), actual: differenceValue(actual) };
  }
  const expectedArray = Array.isArray(expected);
  const actualArray = Array.isArray(actual);
  if (expectedArray !== actualArray) {
    return { path: path || '$', expected: differenceValue(expected), actual: differenceValue(actual) };
  }
  if (expectedArray) {
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      const difference = firstDifference(expected[index], actual[index], appendPath(path, index, true));
      if (difference) return difference;
    }
    if (expected.length !== actual.length) {
      return { path: path ? `${path}.length` : 'length', expected: expected.length, actual: actual.length };
    }
    return null;
  }

  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  const expectedSet = new Set(expectedKeys);
  const actualSet = new Set(actualKeys);
  for (const key of expectedKeys) {
    if (!actualSet.has(key)) {
      return {
        path: appendPath(path, key),
        expected: differenceValue(expected[key]),
        actual: { kind: 'missing' }
      };
    }
    const difference = firstDifference(expected[key], actual[key], appendPath(path, key));
    if (difference) return difference;
  }
  for (const key of actualKeys) {
    if (!expectedSet.has(key)) {
      return {
        path: appendPath(path, key),
        expected: { kind: 'missing' },
        actual: differenceValue(actual[key])
      };
    }
  }
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    return {
      path: path ? `${path}.$keys` : '$keys',
      expected: differenceValue(expectedKeys),
      actual: differenceValue(actualKeys)
    };
  }
  return null;
}

function sanitizeSnapshot(value, limits, state, depth = 0, seen = new Set()) {
  const diagnosed = diagnosticValue(value);
  if (diagnosed !== value) return diagnosed;
  if (typeof value === 'string') {
    if (value.length <= limits.maxStringLength) return value;
    state.truncated = true;
    return `${value.slice(0, limits.maxStringLength)}…`;
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) {
    state.truncated = true;
    return { kind: 'circular-reference' };
  }
  if (depth >= limits.maxDepth) {
    state.truncated = true;
    return { kind: 'max-depth' };
  }
  seen.add(value);
  let output;
  if (Array.isArray(value)) {
    const entries = value.slice(0, limits.maxArrayItems);
    if (entries.length !== value.length) state.truncated = true;
    output = entries.map(entry => sanitizeSnapshot(entry, limits, state, depth + 1, seen));
  } else {
    const keys = Object.keys(value);
    const selected = keys.slice(0, limits.maxObjectKeys);
    if (selected.length !== keys.length) state.truncated = true;
    output = {};
    for (const key of selected) output[key] = sanitizeSnapshot(value[key], limits, state, depth + 1, seen);
  }
  seen.delete(value);
  return output;
}

function truncateUtf8(value, maximumBytes) {
  let output = '';
  for (const character of String(value)) {
    if (Buffer.byteLength(output + character, 'utf8') > maximumBytes) break;
    output += character;
  }
  return output;
}

function boundedSnapshot(value, options = {}) {
  const limits = { ...SNAPSHOT_LIMITS, ...options };
  const state = { truncated: false };
  let snapshot = sanitizeSnapshot(value, limits, state);
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, 'utf8') > limits.maxBytes) {
    state.truncated = true;
    snapshot = {
      kind: 'bounded-json-preview',
      valueType: Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value),
      preview: truncateUtf8(serialized, limits.maxBytes - 512)
    };
  }
  return { value: snapshot, truncated: state.truncated };
}

function boundedExpectedActual(expected, actual, options = {}) {
  const expectedSnapshot = boundedSnapshot(expected, options);
  const actualSnapshot = boundedSnapshot(actual, options);
  const truncatedFields = [];
  if (expectedSnapshot.truncated) truncatedFields.push('expected');
  if (actualSnapshot.truncated) truncatedFields.push('actual');
  return {
    expected: expectedSnapshot.value,
    actual: actualSnapshot.value,
    truncated: truncatedFields.length > 0,
    truncatedFields
  };
}

module.exports = {
  SNAPSHOT_LIMITS,
  diagnosticValue,
  firstDifference,
  boundedSnapshot,
  boundedExpectedActual
};
