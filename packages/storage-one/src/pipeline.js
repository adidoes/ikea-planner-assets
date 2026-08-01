"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { ensureDir, sanitizeFileName, sha256, writeJson } = require("./utils");
const { captureStorageOne } = require("./capture");
const { modelKey, optimizedModelUrl } = require("./catalog");
const { exportStorageOneObj } = require("./export-obj");
const { storageOneProfile } = require("./profile");
const { parseStorageOneReference } = require("./reference");

const ICF_MATCH_TOLERANCE_MM = 2;

async function exportPlatsaPlan(input, options = {}) {
  return exportStorageOnePlan(input, options, "platsa");
}

async function exportPaxPlan(input, options = {}) {
  return exportStorageOnePlan(input, options, "pax");
}

async function exportStorageOnePlan(input, options = {}, planner = "platsa") {
  const profile = storageOneProfile(planner);
  const reference = parseStorageOneReference(input, options, profile);
  const outDir = options.out || profile.defaultOut;
  const name = sanitizeFileName(options.name || `${profile.defaultNamePrefix}-${reference.planId}`);
  await ensureDir(outDir);

  console.log(`Capturing ${profile.label} planner ${reference.planId}...`);
  const capture = await captureStorageOne(reference, options, profile);
  const instances = collectStorageOneInstances(capture.plan, capture.catalogProducts, capture.productLabels);
  if (!instances.length) throw new Error(`Configuration ${reference.planId} contains no exportable ${profile.label} instances`);
  console.log(`Captured ${instances.length} placed instances; downloading ${new Set(instances.map((instance) => instance.productId)).size} model assets...`);
  const { models, downloads, warnings: modelWarnings } = await resolveModels(instances, capture.modelAssets, options);
  console.log(`Downloaded ${models.size} model assets; exporting OBJ geometry...`);

  const rawDir = path.join(outDir, `${name}_source`);
  const modelDir = path.join(rawDir, "models");
  await ensureDir(modelDir);
  const planPath = path.join(rawDir, "plan.json");
  const catalogPath = path.join(rawDir, "catalog-map.json");
  await writeJson(planPath, capture.plan);
  await writeJson(catalogPath, {
    schema: profile.catalogSchema,
    generatedAt: new Date().toISOString(),
    products: Array.from(capture.catalogProducts.values()),
  });

  const rawModelPaths = [];
  for (const [productId, asset] of models) {
    const target = path.join(modelDir, `${sanitizeFileName(productId)}-${sanitizeFileName(asset.key)}.glb`);
    await fs.writeFile(target, asset.buffer);
    asset.path = target;
    rawModelPaths.push(target);
  }

  const exported = await exportStorageOneObj({
    planId: reference.planId,
    instances,
    models,
  }, {
    out: outDir,
    name,
    axis: options.axis || "y-up",
  }, profile);
  const reportPath = path.join(outDir, `${name}.${profile.reportSuffix}`);
  const report = {
    schema: profile.exportSchema,
    generatedAt: new Date().toISOString(),
    source: reference,
    options: {
      axis: options.axis || "y-up",
      modelVariant: options.modelVariant || "compatible",
    },
    outputs: [...exported.outputs, planPath, catalogPath, ...rawModelPaths, reportPath],
    summary: {
      planInstances: instances.length,
      uniqueProducts: new Set(instances.map((instance) => instance.productId)).size,
      resolvedModels: models.size,
      capturedCatalogProducts: capture.catalogProducts.size,
      captureErrors: capture.responseErrors.length,
      ...exported.summary,
    },
    bounds: exported.bounds,
    downloads,
    instances: exported.instances,
    warnings: [...modelWarnings, ...capture.responseErrors, ...exported.warnings],
    capturedUrls: capture.capturedUrls,
  };
  report.summary.warnings = report.warnings.length;
  await writeJson(reportPath, report);
  console.log(`Exported ${exported.summary.instances} ${profile.label} instances to ${exported.objPath}`);
  if (report.warnings.length) console.log(`${report.warnings.length} warnings; see ${reportPath}`);
  return report;
}

function collectPlatsaInstances(plan, catalogProducts, productLabels = new Map()) {
  return collectStorageOneInstances(plan, catalogProducts, productLabels);
}

function collectPaxInstances(plan, catalogProducts, productLabels = new Map()) {
  return collectStorageOneInstances(plan, catalogProducts, productLabels);
}

function collectStorageOneInstances(plan, catalogProducts, productLabels = new Map()) {
  const fromEcs = collectEcsInstances(plan, catalogProducts, productLabels);
  return fromEcs.length ? enrichEcsFromIcf(fromEcs, plan) : collectIcfInstances(plan, catalogProducts, productLabels);
}

function collectIcfInstances(plan, catalogProducts, productLabels) {
  const instances = [];
  for (const article of plan?.icf?.content?.articles || []) {
    const productId = String(article.product_id || "").replace(/^ART-/i, "");
    const catalog = catalogProducts.get(productId);
    if (!productId || !catalog?.modelUri || !article.transform) continue;
    const product = productLabels.get(productId);
    instances.push({
      id: String(article.id),
      productId,
      label: labelFor(productId, product, article.name),
      category: article.category || catalog.type || null,
      parentIds: (article.parent_ids || []).map(String),
      childIds: (article.child_ids || []).map(String),
      dimensionsMm: article.dimensions || null,
      transform: article.transform,
      catalog,
      source: "icf",
    });
  }
  return instances;
}

function collectEcsInstances(plan, catalogProducts, productLabels) {
  const instances = [];
  for (const entity of plan?.configuration?.content?.entities || []) {
    const productId = String(entity.ref || "").replace(/^ART-/i, "");
    const catalog = catalogProducts.get(productId);
    const transform = entity.c?.WorldTransformComponent;
    if (!productId || !catalog?.modelUri || !transform) continue;
    const product = productLabels.get(productId);
    instances.push({
      id: String(entity.id),
      productId,
      label: labelFor(productId, product, null),
      category: catalog.type || null,
      parentIds: entity.parent ? [String(entity.parent)] : [],
      childIds: [],
      dimensionsMm: null,
      transform: {
        position: transform.p || {},
        quaternion: transform.r || { x: 0, y: 0, z: 0, w: 1 },
        scale: transform.s || { x: 1, y: 1, z: 1 },
      },
      catalog,
      source: "ecs",
    });
  }
  return instances;
}

function enrichEcsFromIcf(instances, plan) {
  const available = (plan?.icf?.content?.articles || []).slice();
  for (const instance of instances) {
    const position = instance.transform?.position || {};
    let matchIndex = -1;
    let matchDistanceSquared = Infinity;
    for (let index = 0; index < available.length; index++) {
      const article = available[index];
      const productId = String(article.product_id || "").replace(/^ART-/i, "");
      if (productId !== instance.productId) continue;
      const candidate = article.transform?.position || {};
      // PAX doors currently differ by up to 1.5mm between the ECS and ICF views.
      const deltas = ["x", "y", "z"].map((axis) => (candidate[axis] || 0) - (position[axis] || 0));
      if (deltas.some((delta) => Math.abs(delta) > ICF_MATCH_TOLERANCE_MM)) continue;
      const distanceSquared = deltas.reduce((sum, delta) => sum + delta * delta, 0);
      if (distanceSquared < matchDistanceSquared) {
        matchIndex = index;
        matchDistanceSquared = distanceSquared;
      }
    }
    if (matchIndex < 0) continue;
    const article = available.splice(matchIndex, 1)[0];
    instance.icfId = String(article.id);
    instance.parentIds = (article.parent_ids || []).map(String);
    instance.childIds = (article.child_ids || []).map(String);
    instance.dimensionsMm = article.dimensions || null;
    instance.icfRotationDegrees = article.transform?.rotation || null;
  }
  return instances;
}

async function resolveModels(instances, capturedModels, options) {
  const modelVariant = String(options.modelVariant || "compatible").toLowerCase();
  if (!["compatible", "optimized"].includes(modelVariant)) {
    throw new Error(`Expected modelVariant to be compatible or optimized; got ${options.modelVariant}`);
  }
  const products = new Map();
  for (const instance of instances) if (!products.has(instance.productId)) products.set(instance.productId, instance.catalog);
  const models = new Map();
  const downloads = [];
  const warnings = [];
  const queue = Array.from(products);
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 6));

  async function worker() {
    while (cursor < queue.length) {
      const [productId, catalog] = queue[cursor++];
      const captured = capturedModels.get(catalog.modelKey);
      const preferredUrl = modelVariant === "optimized" ? optimizedModelUrl(catalog.modelUri) : catalog.modelUri;
      let asset = null;
      if (modelVariant === "optimized" && captured) {
        asset = captured;
      } else {
        asset = await fetchModel(preferredUrl, options).catch((error) => {
          warnings.push({ productId, url: preferredUrl, reason: "model-download-failed", error: error.message });
          return null;
        });
      }
      if (!asset && captured) asset = captured;
      if (!asset && modelVariant === "optimized") {
        asset = await fetchModel(catalog.modelUri, options).catch(() => null);
      }
      if (!asset) {
        warnings.push({ productId, modelKey: catalog.modelKey, reason: "model-unavailable" });
        continue;
      }
      const resolved = { ...asset, key: modelKey(asset.url) || catalog.modelKey };
      models.set(productId, resolved);
      downloads.push({
        productId,
        url: resolved.url,
        modelKey: resolved.key,
        bytes: resolved.buffer.length,
        sha256: sha256(resolved.buffer),
        variant: /_opt(?:_|\.)/i.test(resolved.url) ? "optimized" : "compatible",
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { models, downloads, warnings };
}

async function fetchModel(url, options) {
  const headers = {};
  if (options.userAgent) headers["user-agent"] = options.userAgent;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(Number(options.timeoutMs) || 90000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return {
    key: modelKey(url),
    url,
    contentType: response.headers.get("content-type") || "model/gltf-binary",
    buffer: Buffer.from(await response.arrayBuffer()),
  };
}

function labelFor(productId, product, fallback) {
  const words = [product?.name, product?.typeName].filter(Boolean);
  return words.length ? `${words.join(" ")} ${productId}` : (fallback || productId);
}

module.exports = {
  collectEcsInstances,
  collectIcfInstances,
  collectPaxInstances,
  collectPlatsaInstances,
  collectStorageOneInstances,
  enrichEcsFromIcf,
  exportPaxPlan,
  exportPlatsaPlan,
  exportStorageOnePlan,
  fetchModel,
  resolveModels,
};
