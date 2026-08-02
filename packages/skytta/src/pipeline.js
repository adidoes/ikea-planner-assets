"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { exportGlbObj, modelKey } = require("@ikea-planner-assets/storage-one");
const { discoverDexfApiKey, fetchDexfConfiguration, request } = require("@ikea-planner-assets/space/dexf");
const {
  addProductAliases,
  fetchSkyttaProducts,
  findSkyttaProduct,
  normalizeSkyttaProducts,
  selectSkyttaAsset,
  stripEntityVariant,
  stripProductPrefix,
} = require("./catalog");
const { parseSkyttaReference } = require("./reference");

const SKYTTA_EXPORT_PROFILE = Object.freeze({
  id: "skytta",
  label: "IKEA SKYTTA",
  defaultNamePrefix: "skytta",
  exportFunctionName: "exportSkyttaObj",
});

const LIMITATIONS = Object.freeze([
  "Only placed SKYTTA entities with public Webplanner GLB assets are exported; room surfaces and bill-of-material-only fittings are omitted.",
  "Multi-model products are associated by the saved entity variant and Webplanner asset name; an unknown or ambiguous variant is reported and skipped.",
  "The Webplanner asset URL can be a byte-identical CDN alias of the URL loaded by the current planner runtime.",
  "OBJ/MTL preserves embedded base-colour textures and opacity, but not the complete glTF physically based material model.",
  "Designs that require IKEA account authentication are not supported by the public VPC retrieval path.",
]);

async function captureSkyttaPlan(input, options = {}) {
  const reference = parseSkyttaReference(input, options);
  const discovery = options.discovery || await discoverDexfApiKey(reference.platformIndexUrl, options);
  const [configurationCapture, productCapture] = await Promise.all([
    fetchDexfConfiguration(reference, { ...options, discovery }),
    fetchSkyttaProducts(reference, discovery, options),
  ]);
  return {
    reference,
    plan: configurationCapture.plan,
    configurationUrl: configurationCapture.url,
    discovery,
    products: productCapture.products,
    productList: productCapture.productList,
    productsUrl: productCapture.url,
    capturedUrls: uniqueSorted([
      ...(discovery.fetchedUrls || []),
      configurationCapture.url,
      productCapture.url,
    ]),
    responseErrors: [],
  };
}

async function exportSkyttaPlan(input, options = {}) {
  const reference = parseSkyttaReference(input, options);
  const outDir = options.out || "assets/skytta";
  const name = sanitizeFileName(options.name || `skytta-${reference.planId}`);
  await ensureDir(outDir);
  console.log(`Capturing IKEA SKYTTA planner ${reference.planId}...`);
  const capture = options.capture
    ? normalizeSkyttaCapture(options.capture, reference)
    : await captureSkyttaPlan(reference, options);
  const analysis = analyzeSkyttaEntities(capture.plan, capture.products);
  if (!analysis.instances.length) {
    throw new Error(`Configuration ${reference.planId} contains no placed SKYTTA entities with resolvable GLB models`);
  }

  console.log(`Captured ${analysis.instances.length} placed SKYTTA instances; downloading ${new Set(analysis.instances.map((instance) => instance.catalog.modelUri)).size} model assets...`);
  const resolved = await resolveSkyttaModels(analysis.instances, options);
  if (!resolved.models.size) throw new Error(`Could not resolve any GLB models for SKYTTA configuration ${reference.planId}`);

  const rawDir = path.join(outDir, `${name}_source`);
  const modelDir = path.join(rawDir, "models");
  await ensureDir(modelDir);
  const planPath = path.join(rawDir, "plan.json");
  const productMapPath = path.join(rawDir, "product-map.json");
  await writeJson(planPath, capture.plan);
  await writeJson(productMapPath, buildProductMap(capture, analysis));

  const rawModelPaths = [];
  for (const asset of resolved.assets.values()) {
    const target = path.join(modelDir, `${sanitizeFileName(asset.key)}.glb`);
    await fs.writeFile(target, asset.buffer);
    asset.path = target;
    rawModelPaths.push(target);
  }

  console.log(`Downloaded ${resolved.assets.size} model assets; exporting OBJ geometry...`);
  const exported = await exportSkyttaObj({
    planId: reference.planId,
    instances: analysis.instances,
    models: resolved.models,
  }, {
    out: outDir,
    name,
    axis: options.axis || "y-up",
  });

  const reportPath = path.join(outDir, `${name}.skytta-report.json`);
  const warnings = [
    ...(capture.responseErrors || []),
    ...analysis.warnings,
    ...resolved.warnings,
    ...exported.warnings,
  ];
  const report = {
    schema: "ikea-planner-assets.skytta-export.v1",
    generatedAt: new Date().toISOString(),
    reference: capture.reference,
    planner: {
      application: capture.plan?.application || "skytta",
      applicationName: capture.plan?.applicationName || "SKYTTA",
      applicationVersion: capture.plan?.icf?.content?.application_version || null,
      configurationVersion: capture.plan?.configuration?.version || null,
      snapshotContentVersion: capture.plan?.configuration?.content?.version || null,
    },
    options: { axis: options.axis || "y-up" },
    apiKeyDiscovery: capture.discovery ? {
      indexUrl: capture.discovery.indexUrl || null,
      bundleUrl: capture.discovery.bundleUrl || null,
      discovered: Boolean(capture.discovery.discovered),
    } : null,
    objPath: exported.objPath,
    mtlPath: exported.mtlPath,
    reportPath,
    outputs: [...exported.outputs, planPath, productMapPath, ...rawModelPaths, reportPath],
    summary: {
      configurationEntities: capture.plan?.configuration?.content?.entities?.length || 0,
      skyttaEntities: analysis.productEntityCount,
      exportableInstances: analysis.instances.length,
      skippedEntities: analysis.skipped.length,
      billOfMaterialItems: capture.plan?.itemList?.item?.length || 0,
      billOfMaterialOnlyItems: analysis.bomOnlyItems.length,
      uniqueModelAssociations: new Set(analysis.instances.map((instance) => instance.productId)).size,
      uniqueModels: resolved.assets.size,
      ...exported.summary,
      warnings: warnings.length,
    },
    boundsMeters: exported.bounds,
    downloads: resolved.downloads,
    modelAssociations: summarizeAssociations(analysis.instances),
    instances: exported.instances.map((instance) => enrichInstanceReport(instance, analysis.instances)),
    skippedEntities: analysis.skipped,
    billOfMaterialOnlyItems: analysis.bomOnlyItems,
    warnings,
    limitations: LIMITATIONS.slice(),
    capturedUrls: uniqueSorted([
      ...(capture.capturedUrls || []),
      ...resolved.downloads.map((download) => download.url),
    ]),
  };
  await writeJson(reportPath, report);
  console.log(`Exported ${exported.summary.instances} IKEA SKYTTA instances to ${exported.objPath}`);
  return report;
}

async function exportSkyttaObj(bundle, options = {}) {
  return exportGlbObj(bundle, options, SKYTTA_EXPORT_PROFILE);
}

function collectSkyttaInstances(plan, products) {
  return analyzeSkyttaEntities(plan, products).instances;
}

function analyzeSkyttaEntities(plan, products) {
  const entities = plan?.configuration?.content?.entities || [];
  const childIds = new Map();
  for (const entity of entities) {
    if (entity.parent == null) continue;
    const parent = String(entity.parent);
    if (!childIds.has(parent)) childIds.set(parent, []);
    childIds.get(parent).push(String(entity.id));
  }

  const instances = [];
  const skipped = [];
  const warnings = [];
  let productEntityCount = 0;
  for (const entity of entities) {
    if (!isSkyttaProductEntity(entity, products)) continue;
    productEntityCount++;
    const entityRef = String(entity.ref || "");
    const retailProductId = stripEntityVariant(stripProductPrefix(entityRef));
    const product = findSkyttaProduct(products, entityRef);
    if (!product) {
      const skippedEntity = entityWarning(entity, retailProductId, "webplanner-product-not-found");
      skipped.push(skippedEntity);
      warnings.push(skippedEntity);
      continue;
    }
    const selectedAsset = selectSkyttaAsset(product, entityRef, entity);
    if (!selectedAsset) {
      const reason = product.assets.length ? "ambiguous-model-variant" : "product-glb-asset-missing";
      const skippedEntity = entityWarning(entity, retailProductId, reason, product);
      skipped.push(skippedEntity);
      warnings.push(skippedEntity);
      continue;
    }
    const world = entity.c?.WorldTransformComponent;
    if (!world) {
      const skippedEntity = entityWarning(entity, retailProductId, "world-transform-missing", product);
      skipped.push(skippedEntity);
      warnings.push(skippedEntity);
      continue;
    }
    const modelId = product.assets.length > 1 && !entityRef.includes("--")
      ? `${entityRef || retailProductId}--${selectedAsset.name || selectedAsset.modelKey}`
      : entityRef || retailProductId;
    instances.push({
      id: String(entity.id),
      productId: modelId,
      retailProductId,
      entityRef,
      label: [product.name, product.typeName].filter(Boolean).join(" ") || retailProductId,
      category: product.typeName || product.mainTypeName || "SKYTTA part",
      source: "skytta-vpc-world-transform",
      parentIds: entity.parent == null ? [] : [String(entity.parent)],
      childIds: childIds.get(String(entity.id)) || [],
      dimensionsMm: dimensionsForEntity(entity, product),
      transform: {
        position: normalizeVector(world.p, { x: 0, y: 0, z: 0 }),
        quaternion: normalizeQuaternion(world.r),
        scale: normalizeVector(world.s, { x: 1, y: 1, z: 1 }),
      },
      catalog: {
        id: product.id,
        itemId: product.itemId,
        name: product.name,
        typeName: product.typeName,
        dimensionsMm: product.dimensionsMm,
        modelUri: selectedAsset.url,
        modelKey: selectedAsset.modelKey,
        modelTransform: null,
        assetName: selectedAsset.name,
        assetRangeFamily: selectedAsset.rangeFamily,
        assetSource: selectedAsset.source,
        selectionReason: selectedAsset.selectionReason,
      },
    });
  }

  const placedProducts = new Set(instances.map((instance) => instance.retailProductId));
  const bomOnlyItems = (plan?.itemList?.item || []).filter((item) => !placedProducts.has(String(item.itemNo))).map((item) => ({
    itemType: item.itemType || null,
    itemNo: String(item.itemNo || ""),
    quantity: Number(item.quantity) || 0,
    reason: "no-placed-mesh-entity",
  }));
  return { instances, skipped, warnings, bomOnlyItems, productEntityCount };
}

async function resolveSkyttaModels(instances, options = {}) {
  const associations = new Map();
  const warnings = [];
  for (const instance of instances) {
    const existing = associations.get(instance.productId);
    if (existing && existing.url !== instance.catalog.modelUri) {
      warnings.push({ modelId: instance.productId, reason: "model-id-url-conflict", urls: [existing.url, instance.catalog.modelUri] });
      continue;
    }
    associations.set(instance.productId, {
      url: instance.catalog.modelUri,
      retailProductId: instance.retailProductId,
      entityRefs: unique([...(existing?.entityRefs || []), instance.entityRef]),
    });
  }

  const models = new Map();
  const assets = new Map();
  const downloadPromises = new Map();
  const queue = Array.from(associations);
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 6));
  async function worker() {
    while (cursor < queue.length) {
      const [modelId, association] = queue[cursor++];
      let promise = downloadPromises.get(association.url);
      if (!promise) {
        promise = fetchSkyttaModel(association.url, options);
        downloadPromises.set(association.url, promise);
      }
      try {
        const asset = await promise;
        assets.set(asset.url, asset);
        models.set(modelId, asset);
      } catch (error) {
        warnings.push({ modelId, retailProductId: association.retailProductId, url: association.url, reason: "model-download-failed", error: error.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  const downloads = Array.from(assets.values()).map((asset) => {
    const matching = Array.from(associations.entries()).filter(([, association]) => association.url === asset.url);
    return {
      url: asset.url,
      modelKey: asset.key,
      bytes: asset.buffer.length,
      sha256: sha256(asset.buffer),
      modelIds: matching.map(([modelId]) => modelId),
      retailProductIds: unique(matching.map(([, association]) => association.retailProductId)),
    };
  }).sort((left, right) => left.url.localeCompare(right.url));
  return { models, assets, downloads, warnings };
}

async function fetchSkyttaModel(url, options = {}) {
  assertModelUrl(url, options);
  const response = await request(url, options);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 12 || buffer.readUInt32LE(0) !== 0x46546c67) throw new Error(`Expected a binary GLB from ${url}`);
  return {
    key: modelKey(url),
    url,
    contentType: response.headers?.get?.("content-type") || "model/gltf-binary",
    buffer,
  };
}

function normalizeSkyttaCapture(value, reference) {
  const capture = { ...value, reference: value.reference ? parseSkyttaReference(value.reference, reference) : reference };
  if (typeof capture.plan === "string") capture.plan = JSON.parse(capture.plan);
  if (!capture.plan) throw new Error("options.capture.plan is required");
  if (!(capture.products instanceof Map)) {
    if (capture.productPayload) {
      const normalized = normalizeSkyttaProducts(typeof capture.productPayload === "string" ? JSON.parse(capture.productPayload) : capture.productPayload, capture.productsUrl || null);
      capture.products = normalized.products;
      capture.productList ||= normalized.productList;
    } else if (Array.isArray(capture.productList)) {
      capture.products = new Map();
      for (const product of capture.productList) addProductAliases(capture.products, product);
    } else {
      throw new Error("options.capture.products, productList, or productPayload is required");
    }
  }
  capture.productList ||= uniqueProducts(capture.products);
  capture.capturedUrls ||= [];
  capture.responseErrors ||= [];
  return capture;
}

function buildProductMap(capture, analysis) {
  const relevantIds = new Set([
    ...analysis.instances.map((instance) => instance.retailProductId),
    ...analysis.skipped.map((item) => item.retailProductId),
    ...(capture.plan?.itemList?.item || []).map((item) => String(item.itemNo)),
  ]);
  return {
    schema: "ikea-planner-assets.skytta-product-map.v1",
    generatedAt: new Date().toISOString(),
    configurationId: capture.reference.planId,
    sourceUrl: capture.productsUrl || null,
    products: (capture.productList || uniqueProducts(capture.products)).filter((product) => relevantIds.has(product.id)),
    associations: summarizeAssociations(analysis.instances),
  };
}

function summarizeAssociations(instances) {
  const associations = new Map();
  for (const instance of instances) {
    const key = `${instance.productId}\0${instance.catalog.modelUri}`;
    const current = associations.get(key) || {
      modelId: instance.productId,
      entityRef: instance.entityRef,
      retailProductId: instance.retailProductId,
      productName: instance.label,
      assetName: instance.catalog.assetName,
      assetRangeFamily: instance.catalog.assetRangeFamily,
      assetSource: instance.catalog.assetSource,
      selectionReason: instance.catalog.selectionReason,
      modelKey: instance.catalog.modelKey,
      modelUrl: instance.catalog.modelUri,
      instanceIds: [],
    };
    current.instanceIds.push(instance.id);
    associations.set(key, current);
  }
  return Array.from(associations.values());
}

function enrichInstanceReport(report, instances) {
  const source = instances.find((instance) => instance.id === report.id);
  return {
    ...report,
    retailProductId: source?.retailProductId || stripEntityVariant(report.productId),
    entityRef: source?.entityRef || report.productId,
    assetName: source?.catalog?.assetName || null,
    modelKey: source?.catalog?.modelKey || null,
    selectionReason: source?.catalog?.selectionReason || null,
  };
}

function isSkyttaProductEntity(entity, products) {
  const components = entity?.c || {};
  return Boolean(entity?.ref && (
    components.RailComponent
    || components.SlidingDoorFrameComponent
    || components.PanelComponent
    || (components.WorldTransformComponent && findSkyttaProduct(products, entity.ref))
  ));
}

function entityWarning(entity, retailProductId, reason, product = null) {
  return {
    entityId: String(entity.id || ""),
    entityRef: String(entity.ref || ""),
    retailProductId,
    reason,
    availableAssets: product?.assets?.map((asset) => ({ name: asset.name, modelKey: asset.modelKey, url: asset.url })) || [],
  };
}

function dimensionsForEntity(entity, product) {
  const size = entity.c?.params?.size;
  if (!size) return product.dimensionsMm || null;
  return {
    width: finiteNumber(size.width, product.dimensionsMm?.width || 0),
    height: finiteNumber(size.height, product.dimensionsMm?.height || 0),
    depth: finiteNumber(size.depth, product.dimensionsMm?.depth || 0),
  };
}

function normalizeVector(value, fallback) {
  return {
    x: finiteNumber(value?.x, fallback.x),
    y: finiteNumber(value?.y, fallback.y),
    z: finiteNumber(value?.z, fallback.z),
  };
}

function normalizeQuaternion(value) {
  return {
    x: finiteNumber(value?.x, 0),
    y: finiteNumber(value?.y, 0),
    z: finiteNumber(value?.z, 0),
    w: finiteNumber(value?.w, 1),
  };
}

function assertModelUrl(value, options) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid SKYTTA model URL: ${value}`); }
  if (url.protocol !== "https:") throw new Error(`Refusing non-HTTPS SKYTTA model URL: ${value}`);
  const allowed = options.assetHosts || ["content.dexf.ikea.com"];
  if (!allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error(`Refusing SKYTTA model from untrusted host ${url.hostname}`);
  }
}

function uniqueProducts(products) {
  return Array.from(new Map(Array.from(products?.values?.() || []).map((product) => [product.id, product])).values());
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value != null && value !== "").map(String)));
}

function uniqueSorted(values) {
  return unique(values).sort();
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sanitizeFileName(value) {
  return String(value).replace(/[/\\?%*:|"<>]/g, "_").replace(/\s+/g, "_").replace(/_+/g, "_").slice(0, 180);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

module.exports = {
  LIMITATIONS,
  SKYTTA_EXPORT_PROFILE,
  analyzeSkyttaEntities,
  captureSkyttaPlan,
  collectSkyttaInstances,
  exportSkyttaObj,
  exportSkyttaPlan,
  fetchSkyttaModel,
  normalizeSkyttaCapture,
  resolveSkyttaModels,
};
