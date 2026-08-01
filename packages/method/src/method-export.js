"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { assembleInputs } = require("./assemble");
const { captureBrowser } = require("./capture-browser");
const { ensureDir, readJson, sanitizeFileName } = require("./common");
const { convertInputs } = require("./convert");
const { mapAssets } = require("./map-assets");

const DEFAULT_NAME = "ikea-method-kitchen";

async function exportMethodPlan(plannerUrl, options = {}, dependencies = {}) {
  validatePlannerUrl(plannerUrl);
  const steps = {
    captureBrowser: dependencies.captureBrowser || captureBrowser,
    mapAssets: dependencies.mapAssets || mapAssets,
    convertInputs: dependencies.convertInputs || convertInputs,
    assembleInputs: dependencies.assembleInputs || assembleInputs,
  };
  const outDir = path.resolve(options.out || "assets/method");
  const suppliedWorkDir = options.workDir ? path.resolve(options.workDir) : null;
  const workDir = suppliedWorkDir || await fs.mkdtemp(path.join(os.tmpdir(), "ikea-method-export-"));
  const captureDir = path.join(workDir, "capture");
  const convertedDir = path.join(workDir, "converted");
  const manifestPath = path.join(captureDir, "manifest.json");
  const assetMapPath = path.join(workDir, "asset-map.json");
  const assetMapTsvPath = path.join(workDir, "asset-map.tsv");
  const basename = sanitizeFileName(options.name || DEFAULT_NAME) || DEFAULT_NAME;

  await ensureDir(outDir);
  try {
    console.log("Capturing kitchen planner...");
    await steps.captureBrowser(plannerUrl, {
      out: captureDir,
      waitMs: finiteNumber(options.waitMs, 25000),
      headed: Boolean(options.headed),
      saveBodies: true,
      candidate: options.candidate,
      userAgent: options.userAgent,
    });

    const manifest = await readJson(manifestPath);
    const capture = discoverMethodCapture(manifest);

    console.log("Mapping...");
    await steps.mapAssets(capture.bmproj, manifestPath, {
      out: assetMapPath,
      tsv: assetMapTsvPath,
      metadata: capture.metadata,
      products: capture.products,
    });

    console.log("Converting...");
    await steps.convertInputs(capture.convertibleAssets, {
      out: convertedDir,
      format: "obj",
      scale: finiteNumber(options.scale, 0.001),
    });

    console.log("Assembling...");
    const report = await steps.assembleInputs(capture.bmproj, assetMapPath, {
      objDir: convertedDir,
      out: outDir,
      whole: true,
      worktops: options.worktops !== false,
      plinths: options.plinths !== false,
      flat: options.flat !== false,
      axis: options.axis || "y-up",
      name: basename,
      scale: finiteNumber(options.scale, 0.001),
      proxyOverFaces: finiteNumber(options.proxyOverFaces, 0),
      internalParts: options.internalParts || "keep",
    });

    return {
      type: "method",
      outDir,
      name: basename,
      objPath: path.join(outDir, `${basename}.obj`),
      mtlPath: path.join(outDir, `${basename}.mtl`),
      reportPath: path.join(outDir, `${basename}.assembly-report.json`),
      report,
    };
  } finally {
    if (!suppliedWorkDir) await fs.rm(workDir, { recursive: true, force: true });
  }
}

function discoverMethodCapture(manifest) {
  const assets = manifestAssets(manifest).filter((asset) =>
    asset && asset.bodyPath && (asset.status == null || (asset.status >= 200 && asset.status < 300)));
  const bmproj = assets.find((asset) => /\.BMPROJ(?:[?#]|$)/i.test(asset.url || "")) ||
    assets.find((asset) => /\.BMPROJ$/i.test(asset.bodyPath || ""));
  if (!bmproj) {
    throw new Error("The loaded METHOD plan did not expose a .BMPROJ file. Make sure the shared plan opens successfully, then try again.");
  }

  const products = assets
    .filter((asset) => /\/3\/products(?:[/?#]|$)/i.test(asset.url || ""))
    .map((asset) => asset.bodyPath);
  const metadata = assets.find((asset) => /\/projects\/[^/?#]+\/metadata\//i.test(asset.url || ""));
  const convertibleAssets = assets
    .filter((asset) => /\.(?:BM3|BM3MAT)(?:[?#]|$)/i.test(asset.url || "") || /\.(?:BM3|BM3MAT)$/i.test(asset.bodyPath || ""))
    .map((asset) => asset.bodyPath);

  if (!convertibleAssets.length) {
    throw new Error("The loaded METHOD plan did not expose any BM3 geometry assets. Wait for the planner to finish rendering, then try again.");
  }

  return {
    bmproj: bmproj.bodyPath,
    metadata: metadata?.bodyPath || null,
    products: unique(products),
    convertibleAssets: unique(convertibleAssets),
  };
}

function manifestAssets(manifest) {
  if (Array.isArray(manifest)) return manifest;
  if (Array.isArray(manifest?.assets)) return manifest.assets;
  if (Array.isArray(manifest?.requests)) return manifest.requests;
  if (Array.isArray(manifest?.entries)) return manifest.entries;
  return [];
}

function validatePlannerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Expected a METHOD planner URL, got ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Expected an HTTP(S) METHOD planner URL, got ${value}`);
  }
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function unique(values) {
  return Array.from(new Set(values));
}

module.exports = { discoverMethodCapture, exportMethodPlan };
