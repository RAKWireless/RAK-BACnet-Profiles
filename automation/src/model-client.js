'use strict';

const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_MAX_RETRIES = 2;

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

function extractJson(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Model response did not contain a JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

async function completeJson(model, messages, options = {}) {
  const requestBody = {
      model: model.name,
      temperature: 0,
      max_tokens: options.maxTokens || 16000,
      response_format: { type: 'json_object' },
      messages
  };
  let response = await sendRequest(model, requestBody, options);
  if (response.status === 400) {
    const firstFailure = await response.text();
    delete requestBody.response_format;
    response = await sendRequest(model, requestBody, options);
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
  return extractJson(content);
}

async function sendRequest(model, body, options = {}) {
  const timeoutMs = modelTimeoutMs(options);
  const maxRetries = nonNegativeInteger(options.maxRetries, DEFAULT_MAX_RETRIES);
  const retryDelayMs = nonNegativeInteger(options.retryDelayMs, 1000);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
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
      if (!isRetryableStatus(response.status) || attempt === maxRetries) return response;
      await response.arrayBuffer();
    } catch (error) {
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
  extractJson,
  completeJson,
  isRetryableStatus,
  sendRequest
};
