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

function createPinnedLookup(selected) {
  return (_hostname, options, callback) => {
    const address = { address: selected.address, family: selected.family };
    if (options && options.all) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
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
      lookup: createPinnedLookup(selected)
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

function sharePointDownloadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password ||
      !/^[a-z0-9-]+(?:-my)?\.sharepoint\.com$/i.test(url.hostname)) return null;
  const sharedPath = url.pathname.match(/^\/:([a-z]):\/[a-z]\/((?:personal|sites|teams)\/[A-Za-z0-9_.-]+)\/([A-Za-z0-9_-]{16,})\/?$/i);
  if (!sharedPath) return null;
  const download = new URL(url.origin);
  download.pathname = `/${sharedPath[2]}/_layouts/15/download.aspx`;
  download.searchParams.set('share', sharedPath[3]);
  return download.toString();
}

async function fetchDocument(value, redirects = 0) {
  if (redirects > 3) throw new Error('Too many source redirects');
  const directDownload = sharePointDownloadUrl(value);
  const { url, addresses } = await resolveRemoteUrl(directDownload || value);
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

function normalizeStructuredText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function compactText(value) {
  return String(value || '')
    .replace(/^--- Page \d+ ---$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlToText(html) {
  const block = '(?:address|article|aside|blockquote|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|tfoot|thead|tr|ul)';
  return normalizeStructuredText(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<br\b[^>]*\/?\s*>/gi, '\n')
    .replace(new RegExp(`<\\/?${block}\\b[^>]*>`, 'gi'), '\n')
    .replace(/<\/(?:td|th)\s*>/gi, '\t')
    .replace(/<(?:td|th)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[^\S\n\t]+/g, ' ')
    .replace(/ *\t */g, '\t')
    .replace(/\t+\n/g, '\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n'));
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function pdfItem(item, index) {
  if (!item || typeof item.str !== 'string' || item.str.length === 0 ||
      !Array.isArray(item.transform) || item.transform.length < 6) return null;
  const x = Number(item.transform[4]);
  const y = Number(item.transform[5]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const transformHeight = Math.hypot(Number(item.transform[2]) || 0, Number(item.transform[3]) || 0);
  const height = Number.isFinite(Number(item.height)) && Number(item.height) > 0
    ? Number(item.height)
    : transformHeight;
  return {
    str: item.str,
    x,
    y,
    width: Number.isFinite(Number(item.width)) && Number(item.width) > 0 ? Number(item.width) : 0,
    height: height > 0 ? height : 1,
    index
  };
}

function reconstructPdfItems(rawItems) {
  const items = (Array.isArray(rawItems) ? rawItems : [])
    .map(pdfItem)
    .filter(Boolean);
  if (items.length === 0) return '';
  const medianHeight = median(items.map(item => item.height));
  const yTolerance = Math.max(1, medianHeight * 0.35);
  items.sort((left, right) => right.y - left.y || left.x - right.x || left.index - right.index);

  const lines = [];
  for (const item of items) {
    const line = lines[lines.length - 1];
    if (!line || Math.abs(line.y - item.y) > yTolerance) {
      lines.push({ y: item.y, items: [item] });
      continue;
    }
    line.items.push(item);
    line.y = line.items.reduce((sum, entry) => sum + entry.y, 0) / line.items.length;
  }

  return lines.map(line => {
    line.items.sort((left, right) => left.x - right.x || left.index - right.index);
    const lineHeight = median(line.items.map(item => item.height)) || medianHeight || 1;
    let text = '';
    let previous = null;
    for (const item of line.items) {
      if (previous) {
        const gap = item.x - (previous.x + previous.width);
        if (gap > lineHeight * 1.5) text += '\t';
        else if (gap > lineHeight * 0.35) text += ' ';
      }
      text += item.str;
      previous = item;
    }
    return text;
  }).join('\n');
}

async function renderPdfPage(pageData) {
  const pageNumber = Number.isInteger(pageData && pageData.pageNumber) && pageData.pageNumber > 0
    ? pageData.pageNumber
    : 1;
  const marker = `--- Page ${pageNumber} ---`;
  try {
    const content = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false
    });
    const body = reconstructPdfItems(content && content.items);
    return normalizeStructuredText(body ? `${marker}\n${body}` : marker);
  } catch {
    return marker;
  }
}

async function extractSourceText(download) {
  const isPdf = /application\/pdf/i.test(download.contentType) || download.buffer.subarray(0, 4).toString() === '%PDF';
  if (isPdf) {
    const parsed = await pdf(download.buffer, { pagerender: renderPdfPage });
    const text = normalizeStructuredText(parsed.text || '');
    if (compactText(text).length < 200) {
      const error = new Error('PDF appears to be scanned or has insufficient extractable text; OCR is not supported');
      error.code = 'OCR_UNSUPPORTED';
      throw error;
    }
    return { text, type: 'pdf', pages: parsed.numpages || null };
  }
  const isText = /^text\//i.test(download.contentType) || /application\/(?:json|xml|xhtml\+xml)/i.test(download.contentType);
  if (!isText) throw new Error(`Unsupported source content type: ${download.contentType || 'unknown'}`);
  const raw = download.buffer.toString('utf8');
  const isHtml = /text\/html/i.test(download.contentType) || /<html/i.test(raw);
  const text = isHtml
    ? htmlToText(raw)
    : normalizeStructuredText(raw);
  if ((isHtml ? compactText(text).length : text.length) < 100) throw new Error('Source document contains insufficient machine-readable text');
  return { text, type: /html/i.test(download.contentType) ? 'html' : 'text', pages: null };
}

function boundedSourceText(value) {
  return scrubPII(value).slice(0, MAX_SOURCE_TEXT);
}

async function loadOfficialSource(intake) {
  const download = await fetchDocument(intake.datasheetUrl);
  const extracted = await extractSourceText(download);
  return {
    url: download.finalUrl,
    type: extracted.type,
    pages: extracted.pages,
    sha256: crypto.createHash('sha256').update(download.buffer).digest('hex'),
    text: boundedSourceText(extracted.text)
  };
}

function isInlineDecoder(value) {
  return /function\s+(?:Decode|Decoder|decodeUplink|decode)\b|(?:decodeUplink|Decoder)\s*[:=]/i.test(String(value || ''));
}

function decoderFallbackSource(intake, decoder) {
  return {
    url: decoder.url || `Issue #${intake.issueNumber} decoder`,
    type: 'decoder',
    pages: null,
    sha256: decoder.sha256 || null,
    text: boundedSourceText(decoder.text || '')
  };
}

module.exports = {
  isPrivateAddress,
  validateRemoteUrl,
  fetchDocument,
  extractSourceText,
  loadOfficialSource,
  isInlineDecoder,
  decoderFallbackSource,
  createPinnedLookup,
  sharePointDownloadUrl,
  normalizeStructuredText,
  compactText,
  htmlToText,
  reconstructPdfItems,
  renderPdfPage,
  boundedSourceText
};
