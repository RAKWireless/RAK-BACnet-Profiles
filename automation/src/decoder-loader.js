'use strict';

const crypto = require('crypto');
const { fetchDocument, isInlineDecoder } = require('./source-loader');
const { scrubPII } = require('./pii-scrubber');

const DECODER_MAX_TEXT = 40000;
const GITHUB_API = 'https://api.github.com';

function isDecoderCode(text) {
  const value = String(text || '');
  const declaration = /function\s+(?:Decode|Decoder|decodeUplink|decode)\b|(?:decodeUplink|Decoder)\s*[:=]/i;
  return declaration.test(value) && /\{[\s\S]+\}/.test(value);
}

function extractDecoderUrl(value) {
  const urls = String(value || '').match(/https:\/\/[^\s)>`\]]+/gi) || [];
  return urls
    .map(url => url.replace(/[.,;:'"]+$/, ''))
    .find(url => {
      try {
        return !/\.(?:pdf|png|jpe?g|gif|webp|svg)$/i.test(new URL(url).pathname);
      } catch {
        return false;
      }
    }) || null;
}

function githubRawUrl(value) {
  const url = new URL(value);
  if (url.hostname === 'raw.githubusercontent.com') return url.toString();
  if (url.hostname !== 'github.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 5 && (parts[2] === 'blob' || parts[2] === 'raw')) {
    return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts[3]}/${parts.slice(4).join('/')}`;
  }
  return null;
}

function githubTreePath(value) {
  const url = new URL(value);
  if (url.hostname !== 'github.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[2] !== 'tree') return null;
  return { repo: `${parts[0]}/${parts[1]}`, ref: parts[3], dirPath: parts.slice(4).join('/') };
}

function annotateDecoderAuthority(decoder, authority) {
  if (!decoder) return null;
  const userProvided = authority === 'user-provided';
  return {
    ...decoder,
    authority: userProvided ? 'user-provided' : 'supporting',
    authorityReason: userProvided
      ? 'Decoder was explicitly supplied by the Issue submitter and is authoritative protocol evidence'
      : 'Decoder was discovered automatically and remains supporting protocol evidence'
  };
}

async function githubApiJson(endpoint, token) {
  const url = new URL(endpoint, GITHUB_API);
  if (url.origin !== GITHUB_API) throw new Error('GitHub API requests must stay on api.github.com');
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'RAK-BACnet-Profile-Automation/2.0'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) return null;
  return response.json();
}

function decoderResult(text, url, origin) {
  const scrubbed = scrubPII(text).slice(0, DECODER_MAX_TEXT);
  return {
    text: scrubbed,
    url,
    origin,
    sha256: crypto.createHash('sha256').update(scrubbed).digest('hex')
  };
}

async function downloadDecoderText(url) {
  if (!url) return null;
  const download = await fetchDocument(url);
  const text = download.buffer.toString('utf8');
  if (!isDecoderCode(text)) return null;
  return decoderResult(text, download.finalUrl, 'download');
}

async function downloadGitHubTree(value, token, download = downloadDecoderText) {
  const tree = githubTreePath(value);
  if (!tree) return null;
  const encodedPath = tree.dirPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const contents = await githubApiJson(`/repos/${tree.repo}/contents/${encodedPath}?ref=${encodeURIComponent(tree.ref)}`, token);
  if (!Array.isArray(contents)) return null;
  const files = contents
    .filter(item => item && item.type === 'file' && /(?:decoder|codec|payload|uplink|\.js$)/i.test(item.name || ''))
    .sort((left, right) => (/\.(?:js|mjs)$/i.test(left.name || '') ? 0 : 1) - (/\.(?:js|mjs)$/i.test(right.name || '') ? 0 : 1));
  for (const file of files.slice(0, 10)) {
    try {
      const result = await download(file.download_url);
      if (result) return { ...result, origin: 'issue-url' };
    } catch {
      // Try the next file in the explicitly supplied directory.
    }
  }
  return null;
}

function relevantToDevice(result, vendor, model) {
  const haystack = `${result.url || ''}\n${result.text || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedModel = String(model || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return Boolean(normalizedModel.length >= 3 && haystack.includes(normalizedModel));
}

async function searchDecoderOnGitHub(vendor, model, token, download = downloadDecoderText) {
  if (!token || !vendor || !model) return null;
  const queries = [
    `\"${model}\" \"${vendor}\" decodeUplink in:file language:JavaScript`,
    `\"${model}\" Decoder in:file language:JavaScript`,
    `\"${model}\" payload decoder in:path`
  ];
  for (const query of queries) {
    const response = await githubApiJson(`/search/code?q=${encodeURIComponent(query)}&per_page=10`, token);
    if (!response || !Array.isArray(response.items)) continue;
    for (const item of response.items) {
      const rawUrl = githubRawUrl(item.html_url || '');
      if (!rawUrl) continue;
      try {
        const result = await download(rawUrl);
        if (result && relevantToDevice(result, vendor, model)) return { ...result, origin: 'github-search' };
      } catch {
        // Search results are untrusted and may disappear; continue safely.
      }
    }
  }
  return null;
}

async function loadDecoder(intake, options = {}) {
  const download = options.download || downloadDecoderText;
  const downloadTree = options.downloadTree || downloadGitHubTree;
  const search = options.search || searchDecoderOnGitHub;
  if (isInlineDecoder(intake.decoder)) {
    return annotateDecoderAuthority(decoderResult(intake.decoder, `Issue #${intake.issueNumber} decoder`, 'issue-inline'), 'user-provided');
  }

  const url = extractDecoderUrl(intake.decoder);
  if (url) {
    try {
      const raw = githubRawUrl(url);
      if (raw) {
        const result = await download(raw);
        if (result) return annotateDecoderAuthority({ ...result, origin: 'issue-url' }, 'user-provided');
      }
      if (githubTreePath(url)) {
        const result = await downloadTree(url, options.token, download);
        if (result) return annotateDecoderAuthority({ ...result, origin: 'issue-url' }, 'user-provided');
      }
      const result = await download(url);
      if (result) return annotateDecoderAuthority({ ...result, origin: 'issue-url' }, 'user-provided');
    } catch {
      // Fall through to the constrained GitHub search.
    }
  }

  const found = await search(intake.vendor, intake.model, options.token, download);
  return found ? annotateDecoderAuthority({ ...found, origin: 'github-search' }, 'supporting') : null;
}

module.exports = {
  loadDecoder,
  isDecoderCode,
  extractDecoderUrl,
  githubRawUrl,
  githubTreePath,
  relevantToDevice,
  searchDecoderOnGitHub,
  downloadDecoderText
};
