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
const ALLOWED_CONSTRUCTORS = new Set(['Array', 'Uint8Array', 'DataView']);

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

function isSafeLoopBound(node) {
  if (!node) return false;
  if (node.type === 'Literal' && Number.isInteger(node.value)) {
    return node.value >= 0 && node.value <= 4096;
  }
  if (node.type !== 'MemberExpression' || propertyName(node) !== 'length') return false;
  const root = memberRoot(node);
  return root === 'bytes' || root === 'input' || root === 'data';
}

function isBoundedForLoop(node) {
  const variable = loopVariable(node.init);
  if (!variable || !node.test || !node.update) return false;
  if (node.test.type !== 'BinaryExpression' || !['<', '<='].includes(node.test.operator)) return false;
  if (node.test.left.type !== 'Identifier' || node.test.left.name !== variable) return false;
  if (!isSafeLoopBound(node.test.right)) return false;

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
      if (node.computed && !['Identifier', 'Literal'].includes(node.property.type)) {
        errors.push('Computed property expressions must be a simple identifier or literal');
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
    if (['WhileStatement', 'DoWhileStatement', 'ForInStatement', 'ForOfStatement'].includes(node.type)) {
      errors.push(`${node.type} is not allowed; use a provably bounded for loop`);
    }
    if (node.type === 'ForStatement' && !isBoundedForLoop(node)) {
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
