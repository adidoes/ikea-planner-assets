"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { classifyUrl, compileMaybeRegex, shortHash, writeJson } = require("./common");

async function importRequests(input, options) {
  const text = await fs.readFile(input, "utf8");
  const include = compileMaybeRegex(options.include);
  const exclude = compileMaybeRegex(options.exclude);
  const entries = extractEntries(text, input)
    .filter((entry) => !include || include.test(entry.url))
    .filter((entry) => !exclude || !exclude.test(entry.url));

  const unique = new Map();
  for (const entry of entries) {
    const key = entry.url;
    const existing = unique.get(key);
    if (!existing) unique.set(key, entry);
    else {
      existing.sources = Array.from(new Set([...(existing.sources || []), ...(entry.sources || [])]));
      existing.methods = Array.from(new Set([...(existing.methods || []), ...(entry.methods || [])]));
    }
  }

  const assets = Array.from(unique.values()).map((entry) => {
    const classification = classifyUrl(entry.url, entry.contentType || entry.mimeType || "");
    return {
      id: shortHash(entry.url),
      url: entry.url,
      method: entry.method || (entry.methods || ["GET"])[0] || "GET",
      contentType: entry.contentType || entry.mimeType || null,
      status: entry.status || null,
      resourceType: entry.resourceType || null,
      ...classification,
      sources: entry.sources || [path.basename(input)],
    };
  });

  const manifest = {
    schema: "ikea-planner-assets.manifest.v1",
    generatedAt: new Date().toISOString(),
    source: input,
    summary: summarize(assets),
    assets,
  };

  await writeJson(options.out, manifest);
  console.log(`Wrote ${assets.length} manifest entries to ${options.out}`);
  console.log(JSON.stringify(manifest.summary, null, 2));
}

function extractEntries(text, input) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.log && Array.isArray(parsed.log.entries)) {
      return fromHar(parsed, input);
    }
    if (parsed.data && Array.isArray(parsed.data.requests)) {
      return parsed.data.requests.map((request) => ({
        url: request.url,
        method: request.method || "GET",
        contentType: request.mimeType || headerValue(request.responseHeaders, "content-type"),
        status: request.status || null,
        resourceType: request.resourceType || null,
        sources: [input],
      })).filter((entry) => entry.url);
    }
    if (Array.isArray(parsed)) {
      return parsed.map((item) => typeof item === "string" ? { url: item, sources: [input] } : {
        url: item.url || item.name || item.request?.url,
        method: item.method || item.request?.method || "GET",
        contentType: item.contentType || item.mimeType || item.response?.content?.mimeType,
        status: item.status || item.response?.status || null,
        resourceType: item.resourceType || item.initiatorType || null,
        sources: [input],
      }).filter((entry) => entry.url);
    }
  } catch {
    // Fall through to text/cURL extraction.
  }

  return extractUrlsFromText(text).map((url) => ({ url, method: "GET", sources: [input] }));
}

function fromHar(har, input) {
  return har.log.entries.map((entry) => ({
    url: entry.request && entry.request.url,
    method: entry.request && entry.request.method || "GET",
    contentType: entry.response && entry.response.content && entry.response.content.mimeType,
    status: entry.response && entry.response.status,
    resourceType: entry._resourceType || null,
    sources: [input],
  })).filter((entry) => entry.url);
}

function extractUrlsFromText(text) {
  const urls = [];
  const re = /https?:\/\/[^\s'"\\<>`]+/g;
  let match;
  while ((match = re.exec(text))) {
    urls.push(match[0].replace(/[),.;]+$/, ""));
  }
  return Array.from(new Set(urls));
}

function headerValue(headers, name) {
  if (!headers) return null;
  const lower = name.toLowerCase();
  if (Array.isArray(headers)) {
    const found = headers.find((header) => String(header.name).toLowerCase() === lower);
    return found && found.value || null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

function summarize(assets) {
  const byFamily = {};
  const byHost = {};
  for (const asset of assets) {
    byFamily[asset.family] = (byFamily[asset.family] || 0) + 1;
    try {
      const host = new URL(asset.url).host;
      byHost[host] = (byHost[host] || 0) + 1;
    } catch {
      // Ignore invalid URLs; import keeps them visible in the manifest.
    }
  }
  return {
    total: assets.length,
    likelyAssetCount: assets.filter((asset) => asset.likelyAsset).length,
    byFamily,
    byHost,
  };
}

module.exports = { importRequests, extractEntries };
