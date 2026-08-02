"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
const { exportGlbObj, modelKey } = require("@ikea-planner-assets/storage-one");
const { parseEnhetReference } = require("./reference");

async function exportEnhetPlan(input, options = {}) {
  const reference = parseEnhetReference(input, options);
  const outDir = options.out || "assets/enhet";
  const name = sanitize(options.name || `enhet-${reference.planId}`);
  await fs.mkdir(outDir, { recursive: true });

  console.log(`Capturing ENHET planner ${reference.planId}...`);
  const capture = await captureEnhet(reference, options);
  const instances = collectEnhetInstances(capture.plan, capture.catalog);
  if (!instances.length) throw new Error(`Configuration ${reference.planId} contains no exportable ENHET instances`);

  console.log(`Captured ${instances.length} placed instances; downloading ${new Set(instances.map((instance) => instance.productId)).size} model assets...`);
  const { models, downloads, warnings } = await downloadModels(instances, options);
  console.log(`Downloaded ${models.size} model assets; exporting OBJ geometry...`);

  const sourceDir = path.join(outDir, `${name}_source`);
  const modelDir = path.join(sourceDir, "models");
  await fs.mkdir(modelDir, { recursive: true });
  const planPath = path.join(sourceDir, "plan.json");
  const catalogPath = path.join(sourceDir, "catalog.json");
  await fs.writeFile(planPath, `${JSON.stringify(capture.plan, null, 2)}\n`);
  await fs.writeFile(catalogPath, `${JSON.stringify(capture.catalog, null, 2)}\n`);

  const rawModelPaths = [];
  for (const [productId, asset] of models) {
    const target = path.join(modelDir, `${sanitize(productId)}-${sanitize(asset.key)}.glb`);
    await fs.writeFile(target, asset.buffer);
    rawModelPaths.push(target);
  }

  const exported = await exportGlbObj({ planId: reference.planId, instances, models }, {
    out: outDir,
    name,
    axis: options.axis || "y-up",
  }, {
    id: "enhet",
    label: "ENHET",
    defaultNamePrefix: "enhet",
    exportFunctionName: "exportEnhetPlan",
  });

  const reportPath = path.join(outDir, `${name}.enhet-report.json`);
  const report = {
    schema: "ikea-planner-assets.enhet-export.v1",
    generatedAt: new Date().toISOString(),
    source: reference,
    outputs: [...exported.outputs, planPath, catalogPath, ...rawModelPaths, reportPath],
    summary: {
      planInstances: instances.length,
      uniqueProducts: new Set(instances.map((instance) => instance.productId)).size,
      resolvedModels: models.size,
      ...exported.summary,
    },
    bounds: exported.bounds,
    downloads,
    instances: exported.instances,
    warnings: [...capture.warnings, ...warnings, ...exported.warnings],
    capturedUrls: capture.capturedUrls,
  };
  report.summary.warnings = report.warnings.length;
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Exported ${exported.summary.instances} ENHET instances to ${exported.objPath}`);
  return report;
}

async function captureEnhet(reference, options = {}) {
  const timeoutMs = positiveNumber(options.timeoutMs, 90000);
  const settleMs = nonNegativeNumber(options.settleMs, 1200);
  const browser = await chromium.launch({ headless: options.headed !== true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pending = new Set();
  const warnings = [];
  const capturedUrls = new Set();
  let plan = null;
  let catalog = null;
  let resolvePlan;
  const planReady = new Promise((resolve) => { resolvePlan = resolve; });

  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  };

  page.on("response", (response) => {
    const url = response.url();
    if (!response.ok()) return;
    if (/\/vpc\/v1\/configurations\/retailunit\//i.test(url) && url.toUpperCase().endsWith(`/${reference.planId}`)) {
      track(response.json().then((payload) => {
        if (payload?.application?.toLowerCase().includes("coro3") || payload?.applicationName?.toUpperCase().includes("ENHET")) {
          plan = payload;
          capturedUrls.add(url);
          resolvePlan(payload);
        }
      }).catch((error) => warnings.push({ url, reason: "plan-response", error: error.message })));
    } else if (/\/addon-app\/coro3\/catalogs\/enhet\/[^/]+\/latest\/enhet\.json(?:[?#]|$)/i.test(url)) {
      track(response.json().then((payload) => {
        if (Array.isArray(payload)) {
          catalog = payload;
          capturedUrls.add(url);
        }
      }).catch((error) => warnings.push({ url, reason: "catalog-response", error: error.message })));
    }
  });

  try {
    await page.goto(reference.plannerUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await withTimeout(planReady, timeoutMs, `Timed out waiting for ENHET plan ${reference.planId}`);
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 30000) }).catch(() => {});
    if (settleMs) await page.waitForTimeout(settleMs);
    while (pending.size) await Promise.allSettled(Array.from(pending));
  } finally {
    await browser.close();
  }

  if (!plan) throw new Error(`The ENHET planner did not return configuration ${reference.planId}`);
  if (!catalog) throw new Error("The ENHET planner did not return its range catalog");
  return { reference, plan, catalog, warnings, capturedUrls: Array.from(capturedUrls).sort() };
}

function collectEnhetInstances(plan, catalog) {
  const products = indexCatalog(catalog);
  const instances = [];
  for (const article of plan?.icf?.content?.articles || []) {
    const productId = stripPrefix(article.product_id);
    const product = products.get(productId);
    const modelUri = selectModelUri(product);
    if (!productId || !modelUri || !article.transform) continue;
    instances.push({
      id: String(article.id),
      productId,
      label: [article.name || product.name || "ENHET", productId].join(" "),
      category: article.category || product.category || null,
      parentIds: (article.parent_ids || []).map(String),
      childIds: (article.child_ids || []).map(String),
      dimensionsMm: article.dimensions || product.shapeConfig?.size || null,
      transform: {
        position: article.transform.position || {},
        rotation: article.transform.rotation || {},
        scale: article.transform.scale || { x: 1, y: 1, z: 1 },
      },
      source: "icf",
      catalog: { ...product, modelUri, modelKey: modelKey(modelUri), modelTransform: null },
    });
  }
  return instances;
}

function indexCatalog(catalog) {
  const products = new Map();
  for (const product of catalog || []) {
    for (const id of [product.id, stripPrefix(product.dexfId)].filter(Boolean)) products.set(String(id), product);
  }
  return products;
}

function selectModelUri(product) {
  return product?.assets?.find((asset) => asset.fileTypeName === "gltf-binary" || /\.glb(?:[?#]|$)/i.test(asset.url || ""))?.url || null;
}

async function downloadModels(instances, options) {
  const products = new Map();
  for (const instance of instances) if (!products.has(instance.productId)) products.set(instance.productId, instance.catalog);
  const models = new Map();
  const downloads = [];
  const warnings = [];
  let cursor = 0;
  const queue = Array.from(products);
  const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 6));
  async function worker() {
    while (cursor < queue.length) {
      const [productId, product] = queue[cursor++];
      try {
        const response = await fetch(product.modelUri, { signal: AbortSignal.timeout(positiveNumber(options.timeoutMs, 90000)) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        models.set(productId, { key: product.modelKey || modelKey(product.modelUri), url: product.modelUri, buffer });
        downloads.push({ productId, url: product.modelUri, bytes: buffer.length });
      } catch (error) {
        warnings.push({ productId, url: product.modelUri, reason: "model-download-failed", error: error.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { models, downloads, warnings };
}

function stripPrefix(value) {
  return String(value || "").replace(/^(?:ART|SPR)-/i, "");
}

function sanitize(value) {
  return String(value || "enhet").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "enhet";
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { captureEnhet, collectEnhetInstances, exportEnhetPlan, indexCatalog, selectModelUri };
