"use strict";

const { modelKey } = require("@ikea-planner-assets/storage-one");
const { request } = require("./dexf");

const NON_RANGE_CATALOGS = new Set(["ipex-range"]);

async function fetchSpaceCatalogs(plan, reference, options = {}) {
  const declared = plan?.configuration?.content?.catalogs || {};
  const rangeIds = Object.keys(declared).filter((rangeId) => rangeId && !NON_RANGE_CATALOGS.has(rangeId));
  const catalogs = new Map();
  const products = new Map();
  const warnings = [];
  const capturedUrls = [];
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency) || 4));

  async function worker() {
    while (cursor < rangeIds.length) {
      const rangeId = rangeIds[cursor++];
      const url = spaceCatalogUrl(rangeId, reference, options);
      try {
        const response = await request(url, options);
        const payload = await response.json();
        const normalized = normalizeSpaceCatalog(payload, { rangeId, sourceUrl: url, planVersion: declared[rangeId] });
        catalogs.set(rangeId, normalized);
        capturedUrls.push(url);
        for (const product of normalized.products) addProductAliases(products, product);
      } catch (error) {
        warnings.push({ rangeId, url, reason: "catalog-download-failed", error: error.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rangeIds.length) }, worker));
  return { catalogs, products, warnings, capturedUrls: capturedUrls.sort() };
}

function normalizeSpaceCatalog(payload, context = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.products)) {
    throw new Error(`Range ${context.rangeId || "catalog"} returned an unexpected payload`);
  }
  const rangeId = String(payload.range || context.rangeId || "unknown");
  return {
    rangeId,
    rangeVersion: payload.rangeVersion || null,
    schemaVersion: payload.schemaVersion || null,
    planVersion: context.planVersion == null ? null : String(context.planVersion),
    sourceUrl: context.sourceUrl || null,
    products: payload.products.map((product) => normalizeSpaceProduct(product, {
      assetSource: payload.assetSource,
      rangeId,
      rangeVersion: payload.rangeVersion,
      sourceUrl: context.sourceUrl,
    })).filter(Boolean),
  };
}

function normalizeSpaceProduct(product, context = {}) {
  if (!product || product.id == null) return null;
  const id = String(product.id);
  const modelUri = resolveModelUri(product.modelURI, context);
  return {
    id,
    dexf: product.dexf == null ? null : String(product.dexf),
    type: product.type || null,
    description: product.template?.description || null,
    templateId: product.template?.id || null,
    dimensionsMm: normalizeDimensions(product.template?.size || product.template?.comSize),
    parts: Array.isArray(product.template?.parts)
      ? product.template.parts.map((part) => ({ id: String(part.id), partKey: part.partKey || null, main: Boolean(part.main) }))
      : [],
    rangeId: context.rangeId || null,
    rangeVersion: context.rangeVersion || null,
    sourceUrl: context.sourceUrl || null,
    modelUri,
    modelKey: modelUri ? modelKey(modelUri) : null,
    modelTransform: normalizeModelTransform(product.template?.modelTransform),
  };
}

function spaceCatalogUrl(rangeId, reference, options = {}) {
  if (typeof options.catalogUrl === "function") return String(options.catalogUrl(rangeId, reference));
  const origin = options.catalogOrigin || new URL(reference.platformIndexUrl || reference.plannerUrl).origin;
  return new URL(`/addon-app/range/v1.0/${encodeURIComponent(rangeId)}/catalog/latest/`, origin).href;
}

function findCatalogProduct(products, ref) {
  if (!products || ref == null) return null;
  const value = String(ref);
  return products.get(value) || products.get(value.toUpperCase()) || products.get(stripProductPrefix(value)) || null;
}

function addProductAliases(products, product) {
  const aliases = [product.id, product.dexf, stripProductPrefix(product.dexf)];
  for (const alias of aliases.filter(Boolean)) {
    const keys = [String(alias), String(alias).toUpperCase()];
    for (const key of keys) {
      const existing = products.get(key);
      if (!existing || (!existing.modelUri && product.modelUri)) products.set(key, product);
    }
  }
}

function normalizeModelTransform(transform) {
  if (!transform || typeof transform !== "object") return null;
  const normalized = {};
  const position = normalizeVector(transform.p);
  const rotation = normalizeVector(transform.r);
  const scale = normalizeVector(transform.s);
  if (position) normalized.positionMm = position;
  if (rotation) normalized.rotationDegrees = rotation;
  if (scale) normalized.scale = scale;
  return Object.keys(normalized).length ? normalized : null;
}

function normalizeDimensions(size) {
  if (!size || typeof size !== "object") return null;
  const dimensions = {};
  for (const key of ["width", "height", "depth"]) {
    if (Number.isFinite(Number(size[key]))) dimensions[key] = Number(size[key]);
  }
  return Object.keys(dimensions).length ? dimensions : null;
}

function normalizeVector(vector) {
  if (!vector || typeof vector !== "object") return null;
  const normalized = {};
  for (const axis of ["x", "y", "z"]) {
    if (Number.isFinite(Number(vector[axis]))) normalized[axis] = Number(vector[axis]);
  }
  return Object.keys(normalized).length ? normalized : null;
}

function resolveModelUri(modelUri, context) {
  if (!modelUri) return null;
  try {
    if (/^https?:\/\//i.test(modelUri)) return new URL(modelUri).href;
    const base = /^https?:\/\//i.test(context.assetSource || "") ? context.assetSource : context.sourceUrl;
    return base ? new URL(modelUri, base).href : null;
  } catch {
    return null;
  }
}

function stripProductPrefix(value) {
  return value == null ? null : String(value).replace(/^(?:ART|SPR)-/i, "");
}

module.exports = {
  NON_RANGE_CATALOGS,
  addProductAliases,
  fetchSpaceCatalogs,
  findCatalogProduct,
  normalizeModelTransform,
  normalizeSpaceCatalog,
  normalizeSpaceProduct,
  spaceCatalogUrl,
  stripProductPrefix,
};
