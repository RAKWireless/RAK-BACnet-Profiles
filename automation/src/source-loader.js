'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const https = require('https');
const net = require('net');
const pdf = require('pdf-parse');
const { MAX_SOURCE_BYTES, MAX_SOURCE_TEXT } = require('./config');
const { scrubPII } = require('./pii-scrubber');

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224;
  }
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || normalized.startsWith('fe') || normalized.startsWith('ff') ||
    normalized.startsWith('::ffff:');
}

async function resolveRemoteUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Only HTTPS source URLs are allowed');
  if (url.username || url.password) throw new Error('Source URLs must not contain credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await dns.lookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some(entry => isPrivateAddress(entry.address))) {
    throw new Error('Source URL resolves to a private or unsupported address');
  }
  return { url, addresses };
}

async function validateRemoteUrl(value) {
  return (await resolveRemoteUrl(value)).url;
}

function requestAddress(url, selected) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const request = https.request(url, {
      method: 'GET',
      headers: { 'User-Agent': 'RAK-BACnet-Profile-Automation/2.0' },
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family)
    }, response => {
      const declaredLength = Number(response.headers['content-length'] || 0);
      if (declaredLength > MAX_SOURCE_BYTES) {
        response.resume();
        finish(reject, new Error(`Source exceeds ${MAX_SOURCE_BYTES} bytes`));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_SOURCE_BYTES) {
          request.destroy(new Error(`Source exceeds ${MAX_SOURCE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, {
        status: response.statusCode || 0,
        headers: response.headers,
        buffer: Buffer.concat(chunks)
      }));
      response.on('error', error => finish(reject, error));
    });
    request.setTimeout(20000, () => request.destroy(new Error('Source download timed out')));
    request.on('error', error => finish(reject, error));
    request.end();
  });
}

async function requestDocument(url, addresses) {
  let lastError = null;
  for (const address of addresses) {
    try {
      return await requestAddress(url, address);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Source hostname did not resolve to a usable address');
}

async function fetchDocument(value, redirects = 0) {
  if (redirects > 3) throw new Error('Too many source redirects');
  const { url, addresses } = await resolveRemoteUrl(value);
  const response = await requestDocument(url, addresses);
  const location = response.headers.location;
  if (response.status >= 300 && response.status < 400 && location) {
    return fetchDocument(new URL(location, url).toString(), redirects + 1);
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`Source download failed with HTTP ${response.status}`);
  return {
    buffer: response.buffer,
    contentType: response.headers['content-type'] || '',
    finalUrl: url.toString()
  };
}

function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractSourceText(download) {
  const isPdf = /application\/pdf/i.test(download.contentType) || download.buffer.subarray(0, 4).toString() === '%PDF';
  if (isPdf) {
    const parsed = await pdf(download.buffer);
    const text = String(parsed.text || '').replace(/\s+/g, ' ').trim();
    if (text.length < 200) {
      const error = new Error('PDF appears to be scanned or has insufficient extractable text; OCR is not supported');
      error.code = 'OCR_UNSUPPORTED';
      throw error;
    }
    return { text, type: 'pdf', pages: parsed.numpages || null };
  }
  const isText = /^text\//i.test(download.contentType) || /application\/(?:json|xml|xhtml\+xml)/i.test(download.contentType);
  if (!isText) throw new Error(`Unsupported source content type: ${download.contentType || 'unknown'}`);
  const raw = download.buffer.toString('utf8');
  const text = /text\/html/i.test(download.contentType) || /<html/i.test(raw) ? htmlToText(raw) : raw.trim();
  if (text.length < 100) throw new Error('Source document contains insufficient machine-readable text');
  return { text, type: /html/i.test(download.contentType) ? 'html' : 'text', pages: null };
}

async function loadOfficialSource(intake) {
  const download = await fetchDocument(intake.datasheetUrl);
  const extracted = await extractSourceText(download);
  return {
    url: download.finalUrl,
    type: extracted.type,
    pages: extracted.pages,
    sha256: crypto.createHash('sha256').update(download.buffer).digest('hex'),
    text: scrubPII(extracted.text).slice(0, MAX_SOURCE_TEXT)
  };
}

module.exports = { isPrivateAddress, validateRemoteUrl, fetchDocument, extractSourceText, loadOfficialSource };
