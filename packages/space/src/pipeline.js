"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  exportGlbObj,
  modelKey,
  optimizedModelUrl,
} = require("@ikea-planner-assets/storage-one");
const { fetchSpaceCatalogs, findCatalogProduct, stripProductPrefix } = require("./catalog");
const { fetchDexfConfiguration, request } = require("./dexf");
const { parseSpaceReference } = require("./reference");

const SPACE_EXPORT_PROFILE = Object.freeze({
  id: "space",
  label: "IKEA Space",
  defaultNamePrefix: "space",
  exportFunctionName: "exportSpaceObj",
});

const LIMITATIONS = Object.freeze([
  "Only placed catalog entities backed by binary GLB modelURI values are exported; room geometry and catalog-only assembly containers are omitted.",
  "OBJ/MTL preserves base-colour textures and opacity, but not the complete glTF physically based material model.",
  "Space plans identify range catalogs but do not expose immutable catalog URLs, so each range is resolved through its current /latest/ catalog endpoint.",
  "Profile-account designs that require IKEA authentication are not supported by the public VPC retrieval path.",
]);

async function captureSpacePlan(input, options = {}) {
  const reference = parseSpaceReference(input, options);
  const configurationCapture = await fetchDexfConfiguration(reference, options);
  const catalogCapture = await fetchSpaceCatalogs(configurationCapture.plan, reference, options);
  return {
    reference,
    plan: configurationCapture.plan,
    configurationUrl: configurationCapture.url,
    discovery: configurationCapture.discovery,
    catalogs: catalogCapture.catalogs,
    catalogProducts: catalogCapture.products,
    responseErrors: catalogCapture.warnings,
    capturedUrls: uniqueSorted([
      ...configurationCapture.discovery.fetchedUrls,
      configurationCapture.url,
      ...catalogCapture.capturedUrls,
    ]),
  };
}

async function exportSpacePlan(input, options = {}) {
  const reference = parseSpaceReference(input, options);
  const outDir = options.out || "assets/space";
  const name = sanitizeFileName(options.name || `space-${reference.planId}`);
  await ensureDir(outDir);

  console.log(`Capturing IKEA Space planner ${reference.planId}...`);
  const capture = await captureSpacePlan(reference, options);
  const analysis = analyzeSpaceEntities(capture.plan, capture.catalogProducts);
  if (!analysis.instances.length) {
    throw new Error(`Configuration ${reference.planId} contains no placed Space entities with GLB models`);
  }

  console.log(`Captured ${analysis.instances.length} placed instances; downloading ${new Set(analysis.instances.map((instance) => instance.productId)).size} model assets...`);
  const resolved = await resolveSpaceModels(analysis.instances, options);
  if (!resolved.models.size) {
    throw new Error(`Could not resolve any GLB models for Space configuration ${reference.planId}`);
  }

  console.log(`Downloaded ${resolved.models.size} model assets; exporting OBJ geometry...`);
  const rawDir = path.join(outDir, `${name}_source`);
  const modelDir = path.join(rawDir, "models");
  await ensureDir(modelDir);
  const planPath = path.join(rawDir, "plan.json");
  const catalogPath = path.join(rawDir, "catalog-map.json");
  await writeJson(planPath, capture.plan);
  await writeJson(catalogPath, buildCatalogMap(capture, analysis));

  const rawModelPaths = [];
  for (const [productId, asset] of resolved.models) {
    const target = path.join(modelDir, `${sanitizeFileName(productId)}-${sanitizeFileName(asset.key)}.glb`);
    await fs.writeFile(target, asset.buffer);
    asset.path = target;
    rawModelPaths.push(target);
  }

  const exported = await exportSpaceObj({
    planId: reference.planId,
    instances: analysis.instances,
    models: resolved.models,
  }, {
    out: outDir,
    name,
    axis: options.axis || "y-up",
  });

  const reportPath = path.join(outDir, `${name}.space-report.json`);
  const warnings = [
    ...capture.responseErrors,
    ...analysis.warnings,
    ...resolved.warnings,
    ...exported.warnings,
  ];
  const report = {
    schema: "ikea-planner-assets.space-export.v1",
    generatedAt: new Date().toISOString(),
    source: capture.reference,
    options: {
      axis: options.axis || "y-up",
      modelVariant: options.modelVariant || "compatible",
    },
    apiKeyDiscovery: {
      indexUrl: capture.discovery.indexUrl,
      bundleUrl: capture.discovery.bundleUrl,
      discovered: capture.discovery.discovered,
    },
    outputs: [...exported.outputs, planPath, catalogPath, ...rawModelPaths, reportPath],
    summary: {
      configurationEntities: capture.plan?.configuration?.content?.entities?.length || 0,
      productEntities: analysis.productEntityCount,
      exportableInstances: analysis.instances.length,
      skippedProductEntities: analysis.skipped.length,
      uniqueProducts: new Set(analysis.instances.map((instance) => instance.productId)).size,
      resolvedModels: resolved.models.size,
      rangeCatalogs: capture.catalogs.size,
      ...exported.summary,
      warnings: warnings.length,
    },
    bounds: exported.bounds,
    catalogs: Array.from(capture.catalogs.values()).map((catalog) => ({
      rangeId: catalog.rangeId,
      rangeVersion: catalog.rangeVersion,
      planVersion: catalog.planVersion,
      sourceUrl: catalog.sourceUrl,
      products: catalog.products.length,
    })),
    downloads: resolved.downloads,
    instances: exported.instances,
    skippedProducts: analysis.skipped,
    warnings,
    limitations: LIMITATIONS.slice(),
    capturedUrls: uniqueSorted([...capture.capturedUrls, ...resolved.downloads.map((download) => download.url)]),
  };
  await writeJson(reportPath, report);
  console.log(`Exported ${exported.summary.instances} IKEA Space instances to ${exported.objPath}`);
  return report;
}

async function exportSpaceObj(bundle, options = {}) {
  return exportGlbObj(bundle, options, SPACE_EXPORT_PROFILE);
}

function collectSpaceInstances(plan, catalogProducts) {
  return analyzeSpaceEntities(plan, catalogProducts).instances;
}

function analyzeSpaceEntities(plan, catalogProducts) {
  const entities = plan?.configuration?.content?.entities || [];
  const childIds = new Map();
  for (const entity of entities) {
    if (entity.parent == null) continue;
    const parent = String(entity.parent);
    if (!childIds.has(parent)) childIds.set(parent, []);
    childIds.get(parent).push(String(entity.id));
  }

  const icfByProduct = new Map();
  for (const article of plan?.icf?.content?.articles || []) {
    const productId = stripProductPrefix(article.product_id);
    if (!productId) continue;
    if (!icfByProduct.has(productId)) icfByProduct.set(productId, []);
    icfByProduct.get(productId).push(article);
  }

  const instances = [];
  const skipped = [];
  const warnings = [];
  let productEntityCount = 0;
  for (const entity of entities) {
    const ref = String(entity.ref || "");
    if (!ref || !isProductEntity(entity, icfByProduct)) continue;
    productEntityCount++;
    const productId = stripProductPrefix(ref);
    const catalog = findCatalogProduct(catalogProducts, ref);
    const article = icfByProduct.get(productId)?.shift() || null;
    if (!catalog) {
      const skippedProduct = skippedEntity(entity, productId, article, "catalog-product-not-found");
      skipped.push(skippedProduct);
      warnings.push(skippedProduct);
      continue;
    }
    if (!catalog.modelUri) {
      const reason = catalog.parts.length ? "assembly-container-no-model" : "catalog-model-uri-missing";
      const skippedProduct = skippedEntity(entity, productId, article, reason, catalog);
      skipped.push(skippedProduct);
      if (reason !== "assembly-container-no-model") warnings.push(skippedProduct);
      continue;
    }
    if (!/\.glb(?:[?#]|$)/i.test(catalog.modelUri)) {
      const skippedProduct = skippedEntity(entity, productId, article, "unsupported-model-format", catalog);
      skipped.push(skippedProduct);
      warnings.push(skippedProduct);
      continue;
    }
    const transform = entity.c?.WorldTransformComponent;
    if (!transform) {
      const skippedProduct = skippedEntity(entity, productId, article, "missing-world-transform", catalog);
      skipped.push(skippedProduct);
      warnings.push(skippedProduct);
      continue;
    }

    instances.push({
      id: String(entity.id),
      productId,
      label: article?.name || catalog.description || catalog.type || productId,
      category: article?.category || catalog.type || null,
      parentIds: entity.parent == null ? [] : [String(entity.parent)],
      childIds: childIds.get(String(entity.id)) || [],
      dimensionsMm: dimensionsForEntity(entity, article, catalog),
      transform: {
        position: normalizeVector(transform.p, { x: 0, y: 0, z: 0 }),
        quaternion: normalizeQuaternion(transform.r),
        scale: normalizeVector(transform.s, { x: 1, y: 1, z: 1 }),
      },
      catalog,
      source: "space-ecs",
      partKey: entity.c?.ProductPartComponent?.partKey || null,
    });
  }
  return { instances, skipped, warnings, productEntityCount };
}

async function resolveSpaceModels(instances, options = {}) {
  const modelVariant = String(options.modelVariant || "compatible").toLowerCase();
  if (!["compatible", "optimized"].includes(modelVariant)) {
    throw new Error(`Expected modelVariant to be compatible or optimized; got ${options.modelVariant}`);
  }

  const products = new Map();
  for (const instance of instances) if (!products.has(instance.productId)) products.set(instance.productId, instance.catalog);
  const models = new Map();
  const downloads = [];
  const warnings = [];
  const downloadedByUrl = new Map();
  const queue = Array.from(products);
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 6));

  async function worker() {
    while (cursor < queue.length) {
      const [productId, catalog] = queue[cursor++];
      const compatibleUrl = catalog.modelUri;
      const preferredUrl = modelVariant === "optimized" ? optimizedModelUrl(compatibleUrl) : compatibleUrl;
      let asset = await fetchSharedModel(preferredUrl, downloadedByUrl, options).catch((error) => {
        warnings.push({ productId, url: preferredUrl, reason: "model-download-failed", error: error.message });
        return null;
      });
      if (!asset && modelVariant === "optimized") {
        asset = await fetchSharedModel(compatibleUrl, downloadedByUrl, options).catch(() => null);
      }
      if (!asset) {
        warnings.push({ productId, url: compatibleUrl, reason: "model-unavailable" });
        continue;
      }
      models.set(productId, asset);
      downloads.push({
        productId,
        url: asset.url,
        modelKey: asset.key,
        bytes: asset.buffer.length,
        sha256: sha256(asset.buffer),
        variant: /_opt(?:_|\.)/i.test(asset.url) ? "optimized" : "compatible",
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { models, downloads, warnings };
}

async function fetchSpaceModel(url, options = {}) {
  const response = await request(url, options);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 12 || buffer.readUInt32LE(0) !== 0x46546c67) {
    throw new Error(`Expected a binary GLB from ${url}`);
  }
  return {
    key: modelKey(url),
    url,
    contentType: response.headers?.get?.("content-type") || "model/gltf-binary",
    buffer,
  };
}

async function fetchSharedModel(url, downloadedByUrl, options) {
  if (!downloadedByUrl.has(url)) downloadedByUrl.set(url, fetchSpaceModel(url, options));
  return downloadedByUrl.get(url);
}

function buildCatalogMap(capture, analysis) {
  const products = new Map();
  for (const instance of analysis.instances) products.set(`${instance.catalog.rangeId}:${instance.catalog.id}`, instance.catalog);
  for (const skipped of analysis.skipped) {
    if (skipped.catalog) products.set(`${skipped.catalog.rangeId}:${skipped.catalog.id}`, skipped.catalog);
  }
  return {
    schema: "ikea-planner-assets.space-catalog.v1",
    generatedAt: new Date().toISOString(),
    configurationId: capture.reference.planId,
    catalogs: Array.from(capture.catalogs.values()).map((catalog) => ({
      rangeId: catalog.rangeId,
      rangeVersion: catalog.rangeVersion,
      planVersion: catalog.planVersion,
      sourceUrl: catalog.sourceUrl,
    })),
    products: Array.from(products.values()),
  };
}

function isProductEntity(entity, icfByProduct) {
  if (entity.c?.ProductPartComponent || entity.c?.InteractableComponent) return true;
  return icfByProduct.has(stripProductPrefix(entity.ref));
}

function skippedEntity(entity, productId, article, reason, catalog = null) {
  return {
    instanceId: String(entity.id),
    productId,
    label: article?.name || catalog?.description || productId,
    parentId: entity.parent == null ? null : String(entity.parent),
    partKey: entity.c?.ProductPartComponent?.partKey || null,
    reason,
    catalog,
  };
}

function dimensionsForEntity(entity, article, catalog) {
  const size = entity.c?.params?.size;
  if (size) return {
    width: finiteNumber(size.width, finiteNumber(size.x, 0)),
    height: finiteNumber(size.height, finiteNumber(size.y, 0)),
    depth: finiteNumber(size.depth, finiteNumber(size.z, 0)),
  };
  if (article?.dimensions) return {
    width: finiteNumber(article.dimensions.x, 0),
    height: finiteNumber(article.dimensions.y, 0),
    depth: finiteNumber(article.dimensions.z, 0),
  };
  return catalog.dimensionsMm || null;
}

function normalizeVector(value, fallback) {
  const source = value || {};
  return {
    x: finiteNumber(source.x, fallback.x),
    y: finiteNumber(source.y, fallback.y),
    z: finiteNumber(source.z, fallback.z),
  };
}

function normalizeQuaternion(value) {
  const source = value || {};
  return {
    x: finiteNumber(source.x, 0),
    y: finiteNumber(source.y, 0),
    z: finiteNumber(source.z, 0),
    w: finiteNumber(source.w, 1),
  };
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sanitizeFileName(value) {
  return String(value)
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

module.exports = {
  LIMITATIONS,
  SPACE_EXPORT_PROFILE,
  analyzeSpaceEntities,
  captureSpacePlan,
  collectSpaceInstances,
  exportSpaceObj,
  exportSpacePlan,
  fetchSpaceModel,
  resolveSpaceModels,
};
