"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
const { classifyUrl, ensureDir, safeNameFromUrl, sha256, shortHash, writeJson, DEFAULT_ASSET_RE, DEFAULT_CDN_RE } = require("./common");

async function captureBrowser(url, options) {
  await ensureDir(options.out);
  const bodiesDir = path.join(options.out, "bodies");
  if (options.saveBodies) await ensureDir(bodiesDir);

  const candidateRe = options.candidate ? new RegExp(options.candidate, "i") : null;
  const browser = await chromium.launch({ headless: !options.headed });
  const context = await browser.newContext({
    userAgent: options.userAgent,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const requests = new Map();
  const bodies = [];

  page.on("request", (request) => {
    requests.set(request.url(), {
      id: shortHash(`${request.method()} ${request.url()}`),
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      requestHeaders: redactHeaders(request.headers()),
      startedAt: new Date().toISOString(),
    });
  });

  page.on("response", async (response) => {
    const request = response.request();
    const entry = requests.get(response.url()) || {
      id: shortHash(`${request.method()} ${response.url()}`),
      url: response.url(),
      method: request.method(),
      resourceType: request.resourceType(),
    };
    entry.status = response.status();
    entry.contentType = response.headers()["content-type"] || null;
    entry.responseHeaders = redactHeaders(response.headers());
    Object.assign(entry, classifyUrl(entry.url, entry.contentType || ""));
    requests.set(entry.url, entry);

    if (options.saveBodies && shouldSaveBody(entry, candidateRe)) {
      try {
        const body = await response.body();
        const file = path.join(bodiesDir, safeNameFromUrl(entry.url, entry.id));
        await fs.writeFile(file, body);
        entry.bodyPath = file;
        entry.bytes = body.length;
        entry.sha256 = sha256(body);
        bodies.push(file);
      } catch (error) {
        entry.bodyError = error.message;
      }
    }
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  if (options.waitMs > 0) await page.waitForTimeout(options.waitMs);

  const screenshotPath = path.join(options.out, "page.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });
  const finalUrl = page.url();
  const title = await page.title().catch(() => "");
  await browser.close();

  const assets = Array.from(requests.values()).sort((a, b) => a.url.localeCompare(b.url));
  const manifestAssets = assets.map((entry) => ({
    id: entry.id,
    url: entry.url,
    method: entry.method,
    contentType: entry.contentType || null,
    status: entry.status || null,
    resourceType: entry.resourceType || null,
    extension: entry.extension,
    family: entry.family,
    likelyAsset: entry.likelyAsset,
    bodyPath: entry.bodyPath,
    bytes: entry.bytes,
    sha256: entry.sha256,
    sources: ["playwright"],
  }));

  await fs.writeFile(path.join(options.out, "requests.ndjson"), assets.map((asset) => JSON.stringify(asset)).join("\n") + "\n");
  await writeJson(path.join(options.out, "manifest.json"), {
    schema: "ikea-planner-assets.manifest.v1",
    generatedAt: new Date().toISOString(),
    page: { requestedUrl: url, finalUrl, title, screenshotPath },
    summary: summarize(manifestAssets),
    assets: manifestAssets,
  });

  console.log(`Captured ${assets.length} requests from ${finalUrl}`);
  console.log(`Wrote ${path.join(options.out, "manifest.json")}`);
  if (options.saveBodies) console.log(`Saved ${bodies.length} candidate response bodies to ${bodiesDir}`);
}

function shouldSaveBody(entry, candidateRe) {
  if (candidateRe && candidateRe.test(entry.url)) return true;
  return DEFAULT_ASSET_RE.test(entry.url) || DEFAULT_CDN_RE.test(entry.url) || ["brotli", "geometry", "texture", "model", "json"].includes(entry.family);
}

function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (/^(cookie|authorization|x-csrf|x-xsrf|set-cookie)$/i.test(key)) out[key] = "[redacted]";
    else out[key] = value;
  }
  return out;
}

function summarize(assets) {
  const byFamily = {};
  const byHost = {};
  for (const asset of assets) {
    byFamily[asset.family] = (byFamily[asset.family] || 0) + 1;
    try {
      const host = new URL(asset.url).host;
      byHost[host] = (byHost[host] || 0) + 1;
    } catch {}
  }
  return {
    total: assets.length,
    likelyAssetCount: assets.filter((asset) => asset.likelyAsset).length,
    bodyCount: assets.filter((asset) => asset.bodyPath).length,
    byFamily,
    byHost,
  };
}

module.exports = { captureBrowser };
