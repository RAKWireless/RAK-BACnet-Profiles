'use strict';

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

function sendRequest(model, body, options) {
  return fetch(`${model.baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(options.timeoutMs || 120000),
    headers: {
      Authorization: `Bearer ${model.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

module.exports = { extractJson, completeJson };
