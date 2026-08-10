#!/usr/bin/env node
'use strict';

const fs = require('fs');
const acorn = require('acorn');
const { loadYAML } = require('../yaml-parser');

const MAX_CODEC_BYTES = 64 * 1024;
const MAX_AST_NODES = 5000;
const FORBIDDEN_IDENTIFIERS = new Set([
  'require', 'importScripts', 'eval', 'Function', 'AsyncFunction',
  'GeneratorFunction', 'process', 'global', 'globalThis', 'module', 'exports',
  '__filename', '__dirname', 'Buffer', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'console', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'Worker',
  'SharedArrayBuffer', 'Atomics', 'Proxy', 'Date', 'performance', 'crypto',
  'WeakRef', 'FinalizationRegistry'
]);
const FORBIDDEN_PROPERTIES = new Set([
  'constructor', '__proto__', 'prototype', 'caller', 'callee', 'arguments', 'random', 'now'
]);
const ALLOWED_CONSTRUCTORS = new Set(['Array', 'Uint8Array', 'DataView', 'Error', 'TypeError', 'RangeError']);

function propertyName(node) {
  if (!node) return null;
  if (!node.computed && node.property && node.property.type === 'Identifier') {
    return node.property.name;
  }
  if (node.computed && node.property && node.property.type === 'Literal') {
    return String(node.property.value);
  }
  return null;
}

function memberRoot(node) {
  let current = node;
  while (current && current.type === 'MemberExpression') current = current.object;
  return current && current.type === 'Identifier' ? current.name : null;
}

function isSafeComputedProperty(node) {
  if (!node) return false;
  if (['Identifier', 'Literal'].includes(node.type)) return true;
  if (node.type === 'UpdateExpression') {
    return node.operator === '++' && node.argument.type === 'Identifier';
  }
  if (node.type === 'BinaryExpression' && ['+', '-'].includes(node.operator)) {
    return isSafeComputedProperty(node.left) && isSafeComputedProperty(node.right);
  }
  return false;
}

function loopVariable(init) {
  if (!init) return null;
  if (init.type === 'VariableDeclaration' && init.declarations.length === 1) {
    const declaration = init.declarations[0];
    if (declaration.id.type === 'Identifier' && declaration.init && declaration.init.type === 'Literal' && Number.isFinite(declaration.init.value)) {
      return declaration.id.name;
    }
  }
  if (init.type === 'AssignmentExpression' && init.left.type === 'Identifier' && init.right.type === 'Literal') {
    return init.left.name;
  }
  return null;
}

function isSafeLoopBound(node, safeBoundIdentifiers = new Set()) {
  if (!node) return false;
  if (node.type === 'Literal' && Number.isInteger(node.value)) {
    return node.value >= 0 && node.value <= 4096;
  }
  if (node.type === 'Identifier' && safeBoundIdentifiers.has(node.name)) return true;
  if (node.type !== 'MemberExpression' || propertyName(node) !== 'length') return false;
  const root = memberRoot(node);
  return root === 'bytes' || root === 'input' || root === 'data';
}

function identifiersIn(node, results = new Set()) {
  if (!node || typeof node !== 'object') return results;
  if (node.type === 'Identifier') results.add(node.name);
  for (const [key, value] of Object.entries(node)) {
    if (['type', 'start', 'end', 'loc'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => identifiersIn(child, results));
    else if (value && typeof value === 'object') identifiersIn(value, results);
  }
  return results;
}

function containsSafeBound(node, safeBoundIdentifiers, allowLiteral = false) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Literal') return allowLiteral && isSafeLoopBound(node, safeBoundIdentifiers);
  if (isSafeLoopBound(node, safeBoundIdentifiers)) return true;
  return Object.entries(node).some(([key, value]) => {
    if (['type', 'start', 'end', 'loc'].includes(key)) return false;
    if (Array.isArray(value)) return value.some(child => containsSafeBound(child, safeBoundIdentifiers, allowLiteral));
    return value && typeof value === 'object' && containsSafeBound(value, safeBoundIdentifiers, allowLiteral);
  });
}

function positiveProgress(node, variables) {
  let progressed = false;
  function scan(current) {
    if (!current || typeof current !== 'object' || progressed) return;
    if (current.type === 'UpdateExpression' && current.argument.type === 'Identifier' && variables.has(current.argument.name) && current.operator === '++') {
      progressed = true;
      return;
    }
    if (current.type === 'AssignmentExpression' && current.left.type === 'Identifier' && variables.has(current.left.name)) {
      const positiveLiteral = current.right.type === 'Literal' && Number.isFinite(current.right.value) && current.right.value > 0;
      const monotonicAssignment = current.operator === '+=' && positiveLiteral;
      const postIncrementAssignment = current.operator === '=' && current.right.type === 'BinaryExpression' && current.right.operator === '+' &&
        ((current.right.left.type === 'Identifier' && current.right.left.name === current.left.name && current.right.right.type === 'Literal' && current.right.right.value > 0) ||
         (current.right.right.type === 'Identifier' && current.right.right.name === current.left.name && current.right.left.type === 'Literal' && current.right.left.value > 0));
      if (monotonicAssignment || postIncrementAssignment) {
        progressed = true;
        return;
      }
    }
    for (const [key, value] of Object.entries(current)) {
      if (['type', 'start', 'end', 'loc'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(scan);
      else if (value && typeof value === 'object') scan(value);
    }
  }
  scan(node);
  return progressed;
}

function hasBoundedExitGuard(node, safeBoundIdentifiers) {
  let guarded = false;
  function exits(current) {
    if (!current || typeof current !== 'object') return false;
    if (['BreakStatement', 'ReturnStatement', 'ThrowStatement'].includes(current.type)) return true;
    return Object.entries(current).some(([key, value]) => {
      if (['type', 'start', 'end', 'loc'].includes(key)) return false;
      if (Array.isArray(value)) return value.some(exits);
      return value && typeof value === 'object' && exits(value);
    });
  }
  function scan(current) {
    if (!current || typeof current !== 'object' || guarded) return;
    if (current.type === 'IfStatement' && containsSafeBound(current.test, safeBoundIdentifiers, true) && exits(current.consequent)) {
      guarded = true;
      return;
    }
    for (const [key, value] of Object.entries(current)) {
      if (['type', 'start', 'end', 'loc'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(scan);
      else if (value && typeof value === 'object') scan(value);
    }
  }
  scan(node);
  return guarded;
}

function isBoundedForLoop(node, safeBoundIdentifiers) {
  const variable = loopVariable(node.init);
  if (!variable || !node.test || !node.update) return false;
  if (node.test.type !== 'BinaryExpression' || !['<', '<='].includes(node.test.operator)) return false;
  if (node.test.left.type !== 'Identifier' || node.test.left.name !== variable) return false;
  if (!isSafeLoopBound(node.test.right, safeBoundIdentifiers)) return false;

  if (node.update.type === 'UpdateExpression') {
    return node.update.operator === '++' && node.update.argument.type === 'Identifier' && node.update.argument.name === variable;
  }
  return node.update.type === 'AssignmentExpression' &&
    node.update.operator === '+=' &&
    node.update.left.type === 'Identifier' &&
    node.update.left.name === variable &&
    node.update.right.type === 'Literal' &&
    Number.isInteger(node.update.right.value) &&
    node.update.right.value > 0 &&
    node.update.right.value <= 16;
}

function isBoundedCursorLoop(node, safeBoundIdentifiers) {
  const conditionIdentifiers = identifiersIn(node.test || node.body);
  const boundedCondition = containsSafeBound(node.test, safeBoundIdentifiers);
  const guardedExit = hasBoundedExitGuard(node.body, safeBoundIdentifiers);
  if (!boundedCondition && !guardedExit) return false;
  return positiveProgress(node.body, conditionIdentifiers);
}

function collectSafeBoundIdentifiers(ast) {
  const safe = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    function scan(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && containsSafeBound(node.init, safe, false)) {
        if (!safe.has(node.id.name)) {
          safe.add(node.id.name);
          changed = true;
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (['type', 'start', 'end', 'loc'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(scan);
        else if (value && typeof value === 'object') scan(value);
      }
    }
    scan(ast);
  }
  return safe;
}

function functionName(node, parent) {
  if (node.id && node.id.type === 'Identifier') return node.id.name;
  if (parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  return null;
}

function analyzeCodecSafety(codecSource) {
  const errors = [];
  const warnings = [];
  const byteLength = Buffer.byteLength(codecSource || '', 'utf8');
  if (byteLength > MAX_CODEC_BYTES) {
    return { valid: false, errors: [`Codec exceeds ${MAX_CODEC_BYTES} bytes`], warnings, nodeCount: 0 };
  }

  let ast;
  try {
    ast = acorn.parse(codecSource, { ecmaVersion: 2020, sourceType: 'script' });
  } catch (error) {
    return { valid: false, errors: [`JavaScript parse error: ${error.message}`], warnings, nodeCount: 0 };
  }

  let nodeCount = 0;
  const functionStack = [];
  const callGraph = new Map();
  const safeBoundIdentifiers = collectSafeBoundIdentifiers(ast);
  let loopDepth = 0;

  function visit(node, parent = null) {
    if (!node || typeof node.type !== 'string') return;
    nodeCount += 1;
    if (nodeCount > MAX_AST_NODES) return;

    const isFunction = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
    if (isFunction) {
      const name = functionName(node, parent);
      functionStack.push(name);
      if (name && !callGraph.has(name)) callGraph.set(name, new Set());
    }

    if (node.type === 'Identifier' && FORBIDDEN_IDENTIFIERS.has(node.name)) {
      errors.push(`Forbidden identifier '${node.name}'`);
    }
    if (node.type === 'ThisExpression') errors.push("'this' is not allowed in generated codecs");
    if (node.type === 'WithStatement') errors.push("'with' statements are not allowed");
    if (node.type === 'DebuggerStatement') errors.push("'debugger' statements are not allowed");
    if (node.type === 'ImportExpression' || node.type.startsWith('Export')) errors.push('Module loading is not allowed');
    if (node.type === 'AwaitExpression' || node.type === 'YieldExpression' || node.async || node.generator) {
      errors.push('Async and generator execution is not allowed');
    }
    if (node.type === 'Literal' && node.regex) errors.push('Regular expressions are not allowed in generated codecs');
    if (node.type === 'MemberExpression') {
      const property = propertyName(node);
      if (property && FORBIDDEN_PROPERTIES.has(property)) errors.push(`Forbidden property access '${property}'`);
      if (node.computed && !isSafeComputedProperty(node.property)) {
        errors.push('Computed property expressions must use a bounded cursor plus or minus literals');
      }
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
      if (FORBIDDEN_IDENTIFIERS.has(node.callee.name)) errors.push(`Forbidden call '${node.callee.name}'`);
      const currentFunction = functionStack[functionStack.length - 1];
      if (currentFunction) callGraph.get(currentFunction).add(node.callee.name);
      if (currentFunction && node.callee.name === currentFunction) errors.push(`Recursive call to '${currentFunction}' is not allowed`);
    }
    if (node.type === 'NewExpression') {
      const constructor = node.callee.type === 'Identifier' ? node.callee.name : null;
      if (!constructor || !ALLOWED_CONSTRUCTORS.has(constructor)) {
        errors.push(`Constructor '${constructor || 'dynamic'}' is not allowed`);
      }
    }
    const isLoop = ['WhileStatement', 'DoWhileStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement'].includes(node.type);
    if (isLoop) {
      loopDepth += 1;
      if (loopDepth > 2) errors.push('Loop nesting depth must not exceed 2');
    }
    if (node.type === 'ForInStatement') errors.push('For-in loops are not allowed');
    if (node.type === 'ForOfStatement') {
      const safeIterable = node.right.type === 'ArrayExpression' ||
        (node.right.type === 'Identifier' && ['bytes', 'data'].includes(node.right.name));
      if (!safeIterable) errors.push('For-of loop iterable is not provably finite');
    }
    if (['WhileStatement', 'DoWhileStatement'].includes(node.type) && !isBoundedCursorLoop(node, safeBoundIdentifiers)) {
      errors.push(`${node.type} is not provably bounded by payload length or a finite guard with monotonic progress`);
    }
    if (node.type === 'ForStatement' && !isBoundedForLoop(node, safeBoundIdentifiers)) {
      errors.push('For loop is not provably bounded');
    }

    for (const [key, value] of Object.entries(node)) {
      if (['type', 'start', 'end', 'loc'].includes(key)) continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child, node);
      } else if (value && typeof value === 'object') {
        visit(value, node);
      }
    }

    if (isLoop) loopDepth -= 1;
    if (isFunction) functionStack.pop();
  }

  visit(ast);
  const visited = new Set();
  const active = new Set();
  const trail = [];
  function detectCycle(name) {
    if (active.has(name)) {
      const start = trail.indexOf(name);
      errors.push(`Recursive call cycle is not allowed: ${[...trail.slice(start), name].join(' -> ')}`);
      return;
    }
    if (visited.has(name)) return;
    visited.add(name);
    active.add(name);
    trail.push(name);
    for (const called of callGraph.get(name) || []) {
      if (callGraph.has(called)) detectCycle(called);
    }
    trail.pop();
    active.delete(name);
  }
  for (const name of callGraph.keys()) detectCycle(name);
  if (nodeCount > MAX_AST_NODES) errors.push(`Codec AST exceeds ${MAX_AST_NODES} nodes`);

  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    warnings,
    nodeCount
  };
}

function readCodec(filePath) {
  if (/\.ya?ml$/i.test(filePath)) return loadYAML(filePath).codec;
  return fs.readFileSync(filePath, 'utf8');
}

function main() {
  const filePath = process.argv[2];
  const jsonOutput = process.argv.includes('--json');
  if (!filePath) {
    console.error('Usage: node scripts/lib/validation/codec-safety.js <profile.yaml|codec.js> [--json]');
    process.exit(2);
  }
  const report = analyzeCodecSafety(readCodec(filePath));
  console.log(jsonOutput ? JSON.stringify(report, null, 2) : (report.valid ? 'Codec safety: PASS' : `Codec safety: FAIL\n${report.errors.join('\n')}`));
  process.exit(report.valid ? 0 : 1);
}

if (require.main === module) main();

module.exports = { analyzeCodecSafety };
