"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { ensureDir, readJson, safeNameFromUrl, sha256, writeJson } = require("./common");

async function downloadManifest(manifestPath, options) {
  const manifest = await readJson(manifestPath);
  const assets = (manifest.assets || []).filter((asset) => asset.url && (asset.method || "GET").toUpperCase() === "GET");
  await ensureDir(options.out);

  const headers = {};
  if (options.referer) headers.referer = options.referer;
  if (options.userAgent) headers["user-agent"] = options.userAgent;

  const concurrency = Math.max(1, options.concurrency || 6);
  const results = [];
  let next = 0;

  async function worker() {
    while (next < assets.length) {
      const asset = assets[next++];
      results.push(await downloadOne(asset, options.out, headers));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  const downloadManifestPath = path.join(options.out, "download-manifest.json");
  const summary = {
    total: results.length,
    downloaded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
  await writeJson(downloadManifestPath, {
    schema: "ikea-planner-assets.download.v1",
    generatedAt: new Date().toISOString(),
    sourceManifest: manifestPath,
    summary,
    assets: results,
  });
  console.log(`Downloaded ${summary.downloaded}/${summary.total} assets to ${options.out}`);
  if (summary.failed) console.log(`${summary.failed} downloads failed; see ${downloadManifestPath}`);
}

async function downloadOne(asset, outDir, headers) {
  const name = safeNameFromUrl(asset.url, asset.id || "asset");
  const target = path.join(outDir, name);
  try {
    const response = await fetch(asset.url, { headers });
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await fs.writeFile(target, buffer);
    return {
      ...asset,
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: buffer.length,
      sha256: sha256(buffer),
      path: target,
    };
  } catch (error) {
    return {
      ...asset,
      ok: false,
      error: error.message,
      path: target,
    };
  }
}

module.exports = { downloadManifest };
