"use strict";

const fs = require("node:fs/promises");
const { exportGlbObj, modelKey } = require("@ikea-planner-assets/storage-one");
const { extractSofaCatalog, resolveCatalogProduct } = require("./catalog");
const { captureSofaPlan } = require("./capture");
const { parseSofaReference } = require("./reference");

async function exportSofaPlan(input, options = {}, range = null) {
  if (!options.out) throw new Error("exportSofaPlan requires options.out");
  const reference = parseSofaReference(input, options, range);
  console.log(`Capturing ${reference.range.toUpperCase()} sofa planner ${reference.code}...`);
  const capture = options.capture
    ? normalizeCapture(options.capture, reference)
    : await captureSofaPlan(reference, options, range);
  const catalog = capture.catalog || extractSofaCatalog(capture.catalogSource, capture.catalogUrl);
  const collected = collectSofaInstances(capture.plan, catalog);
  if (!collected.instances.length) {
    const reasons = collected.warnings.map((warning) => `${warning.entityId || "?"}:${warning.reason}`).join(", ");
    throw new Error(`Sofa design ${reference.code} has no resolvable mesh entities${reasons ? ` (${reasons})` : ""}`);
  }

  console.log(`Captured ${collected.instances.length} placed instances; downloading ${new Set(collected.instances.map((instance) => instance.productId)).size} model assets...`);
  const assets = normalizeModelAssets(capture.modelAssets);
  await downloadMissingModels(collected.instances, assets, options);
  const models = new Map();
  for (const instance of collected.instances) {
    const asset = findAsset(assets, instance.catalog.modelUri);
    if (asset) models.set(instance.productId, asset);
    else collected.warnings.push({ entityId: instance.id, ref: instance.productId, modelUrl: instance.catalog.modelUri, reason: "missing-model" });
  }
  if (!models.size) throw new Error(`No GLB assets were available for sofa design ${reference.code}`);

  console.log(`Downloaded ${models.size} model assets; exporting OBJ geometry...`);
  const exported = await exportGlbObj({
    planId: reference.code,
    instances: collected.instances,
    models,
  }, options, {
    id: reference.range,
    label: `IKEA ${String(capture.plan?.applicationName || reference.range).toUpperCase()} sofa planner`,
    defaultNamePrefix: `ikea-${reference.range}`,
    exportFunctionName: "exportSofaPlan",
  });

  const reportPath = exported.objPath.replace(/\.obj$/i, ".sofa-report.json");
  const report = {
    format: "ikea-sofa-assembly-report-v1",
    reference,
    planner: {
      application: capture.plan?.application || reference.range,
      applicationName: capture.plan?.applicationName || null,
      configurationId: capture.plan?.configurationId || reference.code,
      configurationVersion: capture.plan?.configuration?.version || null,
      snapshotContentVersion: capture.plan?.configuration?.content?.version || null,
      rangeContentVersion: capture.contentVersion || null,
      appVersion: capture.appVersion || null,
    },
    capture: {
      planUrl: capture.planUrl || null,
      catalogUrl: capture.catalogUrl || null,
      capturedUrls: capture.capturedUrls || [],
      responseErrors: capture.responseErrors || [],
    },
    summary: exported.summary,
    boundsMeters: exported.bounds,
    instances: exported.instances,
    warnings: [...collected.warnings, ...exported.warnings],
    limitations: [
      "Exports mesh-bearing entities stored in a public VPC design; room helpers and connector-only entities are intentionally omitted.",
      "Standalone SPR product links are not saved designs and must first be shared from the planner.",
      "Materials are preserved when their images are embedded in the planner GLB; external-only image URIs are reported as warnings.",
    ],
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Exported ${exported.summary.instances} ${reference.range.toUpperCase()} instances to ${exported.objPath}`);
  return {
    ...exported,
    outputs: [...exported.outputs, reportPath],
    reportPath,
    report,
    reference,
    capture,
  };
}

function collectSofaInstances(plan, catalog) {
  const content = plan?.configuration?.content || plan?.content || plan;
  const entities = Array.isArray(content?.entities) ? content.entities : [];
  const instances = [];
  const warnings = [];
  for (const entity of entities) {
    if (!entity?.ref) continue;
    const component = entity.c || entity.components || {};
    const state = component.FeatureComponent?.currentState;
    const candidates = unique([
      entity.ref,
      state && !String(entity.ref).endsWith(`--${state}`) ? `${entity.ref}--${state}` : null,
      component.DexfComponent?.id,
    ]);
    let product = null;
    let productId = null;
    for (const candidate of candidates) {
      const resolved = resolveCatalogProduct(catalog, candidate);
      if (resolved?.modelUri) {
        product = resolved;
        productId = String(candidate);
        break;
      }
    }
    if (!product) {
      warnings.push({ entityId: String(entity.id || ""), ref: entity.ref, reason: "catalog-model-not-found" });
      continue;
    }
    const world = component.WorldTransformComponent || component.TransformComponent || {};
    const rotation = world.r || world.rotation || {};
    const transform = {
      position: normalizeVector(world.p || world.position),
      scale: normalizeScale(world.s || world.scale),
    };
    if (rotation.w != null) transform.quaternion = normalizeQuaternion(rotation);
    else transform.rotation = normalizeVector(rotation);
    const dimensionsMm = component.params?.size || product.dimensionsMm || null;
    instances.push({
      id: String(entity.id || instances.length + 1),
      productId,
      label: product.description || entity.ref,
      category: "sofa-part",
      source: "vpc-world-transform",
      parentIds: entity.parent == null ? [] : [String(entity.parent)],
      childIds: entities.filter((candidate) => String(candidate?.parent) === String(entity.id)).map((child) => String(child.id)),
      dimensionsMm,
      transform,
      catalog: product,
    });
  }
  return { instances, warnings };
}

async function downloadMissingModels(instances, assets, options) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("A Fetch API implementation is required to download sofa GLBs");
  const urls = unique(instances.map((instance) => instance.catalog.modelUri));
  const concurrency = Math.max(1, Math.min(8, Number(options.downloadConcurrency) || 4));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      if (findAsset(assets, url)) continue;
      assertModelUrl(url, options);
      const response = await fetchImpl(url);
      if (!response?.ok) throw new Error(`Could not download sofa model ${url}: HTTP ${response?.status || "unknown"}`);
      const asset = {
        key: modelKey(url),
        url,
        contentType: response.headers?.get?.("content-type") || "model/gltf-binary",
        buffer: Buffer.from(await response.arrayBuffer()),
      };
      assets.set(url, asset);
      assets.set(asset.key, asset);
    }
  }));
}

function assertModelUrl(value, options) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid sofa model URL: ${value}`); }
  if (url.protocol !== "https:") throw new Error(`Refusing non-HTTPS sofa model URL: ${value}`);
  const allowed = options.assetHosts || ["content.dexf.ikea.com"];
  if (!allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error(`Refusing sofa model from untrusted host ${url.hostname}`);
  }
}

function normalizeCapture(value, reference) {
  const capture = { ...value, reference: value.reference || reference };
  if (typeof capture.plan === "string") capture.plan = JSON.parse(capture.plan);
  if (!capture.plan) throw new Error("options.capture.plan is required");
  if (!capture.catalog && !capture.catalogSource) throw new Error("options.capture.catalogSource or options.capture.catalog is required");
  if (!capture.catalog && capture.catalogSource) capture.catalog = extractSofaCatalog(capture.catalogSource, capture.catalogUrl);
  capture.modelAssets = normalizeModelAssets(capture.modelAssets);
  return capture;
}

function normalizeModelAssets(value) {
  const assets = new Map();
  const entries = value instanceof Map ? value.entries() : Object.entries(value || {});
  for (const [entryKey, raw] of entries) {
    const asset = Buffer.isBuffer(raw) ? { buffer: raw } : { ...(raw || {}) };
    if (typeof asset.buffer === "string") asset.buffer = Buffer.from(asset.buffer, "base64");
    if (!Buffer.isBuffer(asset.buffer) && asset.buffer instanceof Uint8Array) asset.buffer = Buffer.from(asset.buffer);
    if (!asset.buffer) continue;
    asset.url = asset.url || (/^https?:/i.test(entryKey) ? entryKey : null);
    asset.key = asset.key || modelKey(asset.url || entryKey);
    assets.set(entryKey, asset);
    if (asset.url) assets.set(asset.url, asset);
    if (asset.key) assets.set(asset.key, asset);
  }
  return assets;
}

function findAsset(assets, url) {
  return assets.get(url) || assets.get(modelKey(url)) || null;
}

function normalizeVector(value = {}) {
  return { x: Number(value.x) || 0, y: Number(value.y) || 0, z: Number(value.z) || 0 };
}

function normalizeScale(value = {}) {
  return {
    x: value.x == null ? 1 : Number(value.x),
    y: value.y == null ? 1 : Number(value.y),
    z: value.z == null ? 1 : Number(value.z),
  };
}

function normalizeQuaternion(value = {}) {
  return {
    x: Number(value.x) || 0,
    y: Number(value.y) || 0,
    z: Number(value.z) || 0,
    w: value.w == null ? 1 : Number(value.w),
  };
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value != null && value !== "").map(String)));
}

module.exports = {
  collectSofaInstances,
  downloadMissingModels,
  exportSofaPlan,
  normalizeCapture,
  normalizeModelAssets,
};
