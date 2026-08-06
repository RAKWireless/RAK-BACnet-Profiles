'use strict';

const { logProgress, elapsedSeconds } = require('./progress');

const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_HEARTBEAT_MS = 60000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function modelTimeoutMs(options = {}) {
  return positiveInteger(options.timeoutMs ?? process.env.PROFILE_MODEL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function isRetryableRequestError(error) {
  return error && ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name);
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function startRequestHeartbeat(operation, model, attempt, totalAttempts, timeoutMs, intervalMs) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    logProgress('model', 'still waiting for HTTP response', {
      operation,
      model: model.label,
      httpAttempt: `${attempt}/${totalAttempts}`,
      elapsedSeconds: elapsedSeconds(startedAt),
      timeoutSeconds: timeoutMs / 1000
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

function extractJson(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Model response did not contain a JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

async function completeJson(model, messages, options = {}) {
  const operation = options.operation || 'json-completion';
  const startedAt = Date.now();
  const requestBody = {
      model: model.name,
      temperature: 0,
      max_tokens: options.maxTokens || 16000,
      response_format: { type: 'json_object' },
      messages
  };
  logProgress('model', 'completion started', {
    operation,
    model: model.label,
    maxTokens: requestBody.max_tokens,
    requestBytes: Buffer.byteLength(JSON.stringify(requestBody), 'utf8')
  });
  let response = await sendRequest(model, requestBody, options);
  if (response.status === 400) {
    logProgress('model', 'response_format rejected; retrying without it', {
      operation,
      model: model.label
    });
    const firstFailure = await response.text();
    delete requestBody.response_format;
    response = await sendRequest(model, requestBody, { ...options, operation: `${operation}-compatibility-fallback` });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      throw new Error(`Model ${model.label} failed with HTTP ${response.status}: ${detail || firstFailure.slice(0, 1000)}`);
    }
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`Model ${model.label} failed with HTTP ${response.status}: ${detail}`);
  }
  const payload = await response.json();
  const content = payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
  const result = extractJson(content);
  const usage = payload.usage || {};
  logProgress('model', 'completion parsed', {
    operation,
    model: model.label,
    elapsedSeconds: elapsedSeconds(startedAt),
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  });
  return result;
}

async function sendRequest(model, body, options = {}) {
  const timeoutMs = modelTimeoutMs(options);
  const maxRetries = nonNegativeInteger(options.maxRetries, DEFAULT_MAX_RETRIES);
  const retryDelayMs = nonNegativeInteger(options.retryDelayMs, 1000);
  const heartbeatMs = positiveInteger(options.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  const operation = options.operation || 'json-completion';

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptStartedAt = Date.now();
    logProgress('model', 'HTTP request started', {
      operation,
      model: model.label,
      httpAttempt: `${attempt + 1}/${maxRetries + 1}`,
      timeoutSeconds: timeoutMs / 1000
    });
    const stopHeartbeat = startRequestHeartbeat(
      operation,
      model,
      attempt + 1,
      maxRetries + 1,
      timeoutMs,
      heartbeatMs
    );
    try {
      const response = await fetch(`${model.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${model.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      stopHeartbeat();
      logProgress('model', 'HTTP response received', {
        operation,
        model: model.label,
        httpAttempt: `${attempt + 1}/${maxRetries + 1}`,
        status: response.status,
        elapsedSeconds: elapsedSeconds(attemptStartedAt)
      });
      if (!isRetryableStatus(response.status) || attempt === maxRetries) return response;
      await response.arrayBuffer();
      logProgress('model', 'transient HTTP response; scheduling retry', {
        operation,
        model: model.label,
        status: response.status,
        retryInSeconds: (retryDelayMs * (2 ** attempt)) / 1000
      });
    } catch (error) {
      stopHeartbeat();
      logProgress('model', 'HTTP request failed', {
        operation,
        model: model.label,
        httpAttempt: `${attempt + 1}/${maxRetries + 1}`,
        errorType: error && error.name,
        elapsedSeconds: elapsedSeconds(attemptStartedAt),
        willRetry: isRetryableRequestError(error) && attempt < maxRetries
      });
      if (!isRetryableRequestError(error) || attempt === maxRetries) {
        const timeout = error && ['AbortError', 'TimeoutError'].includes(error.name);
        const wrapped = new Error(timeout
          ? `Model ${model.label} timed out after ${timeoutMs} ms (${attempt + 1} request attempts)`
          : `Model ${model.label} request failed after ${attempt + 1} attempts: ${error.message}`);
        wrapped.code = timeout ? 'MODEL_TIMEOUT' : 'MODEL_REQUEST_FAILED';
        throw wrapped;
      }
    }
    if (retryDelayMs > 0) await wait(retryDelayMs * (2 ** attempt));
  }
  throw new Error(`Model ${model.label} request did not produce a response`);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_HEARTBEAT_MS,
  extractJson,
  completeJson,
  isRetryableStatus,
  sendRequest
};
