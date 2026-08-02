"use strict";

const API_KEY_PATTERNS = [
  /\bdexfApiKey\s*:\s*(["'`])([^"'`]+)\1/,
  /["']dexfApiKey["']\s*:\s*(["'`])([^"'`]+)\1/,
  /\bdexfApiKey\s*=\s*(["'`])([^"'`]+)\1/,
];

async function discoverDexfApiKey(indexUrl, options = {}) {
  if (options.dexfApiKey) {
    return {
      apiKey: String(options.dexfApiKey),
      indexUrl: new URL(indexUrl).href,
      bundleUrl: null,
      discovered: false,
      fetchedUrls: [],
    };
  }

  const resolvedIndexUrl = new URL(indexUrl).href;
  const html = await fetchText(resolvedIndexUrl, options);
  const inlineKey = extractDexfApiKey(html);
  if (inlineKey) {
    return {
      apiKey: inlineKey,
      indexUrl: resolvedIndexUrl,
      bundleUrl: null,
      discovered: true,
      fetchedUrls: [resolvedIndexUrl],
    };
  }

  const scriptUrls = extractScriptUrls(html, resolvedIndexUrl).sort((left, right) => scriptPriority(left) - scriptPriority(right));
  const fetchedUrls = [resolvedIndexUrl];
  for (const bundleUrl of scriptUrls) {
    const source = await fetchText(bundleUrl, options).catch(() => null);
    if (source == null) continue;
    fetchedUrls.push(bundleUrl);
    const apiKey = extractDexfApiKey(source);
    if (apiKey) {
      return {
        apiKey,
        indexUrl: resolvedIndexUrl,
        bundleUrl,
        discovered: true,
        fetchedUrls,
      };
    }
  }

  throw new Error(`Could not discover a public DEXF API key from ${resolvedIndexUrl}`);
}

async function fetchDexfConfiguration(reference, options = {}) {
  const discovery = options.discovery || await discoverDexfApiKey(reference.platformIndexUrl || options.indexUrl, options);
  const url = configurationUrl(reference, options);
  const plan = await fetchJson(url, {
    ...options,
    headers: {
      ...options.headers,
      "dexf-api-key": discovery.apiKey,
    },
  });
  if (!plan || typeof plan !== "object" || !plan.configuration) {
    throw new Error(`DEXF configuration ${reference.planId} returned an unexpected payload`);
  }
  return { plan, url, discovery };
}

function configurationUrl(reference, options = {}) {
  const baseUrl = ensureTrailingSlash(options.dexfBaseUrl || "https://api.dexf.ikea.com/");
  const retailUnit = encodeURIComponent(String(reference.retailUnit).toUpperCase());
  const locale = encodeURIComponent(String(reference.locale));
  const planId = encodeURIComponent(String(reference.planId).toUpperCase());
  return new URL(`vpc/v1/configurations/retailunit/${retailUnit}/locale/${locale}/${planId}`, baseUrl).href;
}

function extractDexfApiKey(source) {
  const text = String(source || "");
  for (const pattern of API_KEY_PATTERNS) {
    const value = text.match(pattern)?.[2];
    if (isPlausibleApiKey(value)) return value;
  }
  return null;
}

function extractScriptUrls(html, baseUrl) {
  const urls = [];
  const seen = new Set();
  for (const match of String(html || "").matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1/gi)) {
    const url = new URL(match[2], baseUrl).href;
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

async function fetchJson(url, options = {}) {
  const response = await request(url, options);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Expected JSON from ${url}: ${error.message}`);
  }
}

async function fetchText(url, options = {}) {
  const response = await request(url, options);
  return response.text();
}

async function request(url, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  const headers = { ...options.headers };
  if (options.userAgent && !headers["user-agent"]) headers["user-agent"] = options.userAgent;
  const init = { method: options.method || "GET", headers };
  if (options.body != null) init.body = options.body;
  if (options.signal) init.signal = options.signal;
  else if (typeof AbortSignal?.timeout === "function") init.signal = AbortSignal.timeout(positiveNumber(options.timeoutMs, 90000));
  const response = await fetchImpl(url, init);
  if (!response?.ok) throw new Error(`HTTP ${response?.status || "error"} while fetching ${url}`);
  return response;
}

function isPlausibleApiKey(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 512 && !/\s/.test(value);
}

function scriptPriority(url) {
  if (/\/static\/js\/index\.[^/]+\.js(?:[?#]|$)/i.test(url)) return 0;
  if (/\b(?:main|app|config)\b/i.test(url)) return 1;
  if (/\bvendor\b/i.test(url)) return 3;
  return 2;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function ensureTrailingSlash(value) {
  return String(value).endsWith("/") ? String(value) : `${value}/`;
}

module.exports = {
  configurationUrl,
  discoverDexfApiKey,
  extractDexfApiKey,
  extractScriptUrls,
  fetchDexfConfiguration,
  fetchJson,
  fetchText,
  request,
};
