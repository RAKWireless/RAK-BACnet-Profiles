'use strict';

const vm = require('vm');

const DEFAULT_TIMEOUT_MS = 250;
const MAX_RESULT_BYTES = 1024 * 1024;

function createContext() {
  const sandbox = Object.create(null);
  return vm.createContext(sandbox, {
    name: 'bacnet-codec',
    codeGeneration: { strings: false, wasm: false }
  });
}

function compileCodec(codecSource, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (typeof codecSource !== 'string' || codecSource.trim() === '') {
    throw new Error('Codec source must be a non-empty string');
  }

  const context = createContext();
  const script = new vm.Script(`"use strict";\n${codecSource}`, {
    filename: 'codec.js'
  });
  script.runInContext(context, { timeout: timeoutMs });
  return context;
}

function invokeCodec(codecSource, functionName, input, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const context = compileCodec(codecSource, timeoutMs);
  const serializedInput = JSON.stringify(input).replace(/[\u2028\u2029]/g, character => (
    character === '\u2028' ? '\\u2028' : '\\u2029'
  ));
  const invocation = new vm.Script(
    `typeof ${functionName} === "function" ? JSON.stringify(${functionName}(${serializedInput})) : "__MISSING_FUNCTION__"`,
    { filename: 'codec-invocation.js' }
  );
  const serializedResult = invocation.runInContext(context, { timeout: timeoutMs });

  if (serializedResult === '__MISSING_FUNCTION__') {
    throw new Error(`${functionName} function not found in codec`);
  }
  if (typeof serializedResult !== 'string') {
    throw new Error(`${functionName} returned a value that is not JSON serializable`);
  }
  if (Buffer.byteLength(serializedResult, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error(`${functionName} output exceeds ${MAX_RESULT_BYTES} bytes`);
  }

  return JSON.parse(serializedResult);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  compileCodec,
  invokeCodec
};
