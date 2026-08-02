"use strict";

const { modelKey } = require("@ikea-planner-assets/storage-one");
const { request } = require("@ikea-planner-assets/space/dexf");

const SKYTTA_PRODUCT_FIELDS = Object.freeze([
  "appConfig",
  "asset",
  "assetV2",
  "genericProduct",
  "measure",
]);

async function fetchSkyttaProducts(reference, discovery, options = {}) {
  const url = skyttaProductsUrl(reference, options);
  const response = await request(url, {
    ...options,
    headers: {
      ...options.headers,
      "dexf-api-key": discovery.apiKey,
    },
  });
  const payload = await response.json();
  const normalized = normalizeSkyttaProducts(payload, url);
  return { ...normalized, payload, url };
}

function skyttaProductsUrl(reference, options = {}) {
  if (options.productsUrl) return typeof options.productsUrl === "function"
    ? String(options.productsUrl(reference))
    : new URL(String(options.productsUrl)).href;
  const baseUrl = ensureTrailingSlash(options.dexfBaseUrl || "https://api.dexf.ikea.com/");
  const retailUnit = encodeURIComponent(String(reference.retailUnit).toUpperCase());
  const locale = encodeURIComponent(String(reference.locale));
  const fields = (options.productFields || SKYTTA_PRODUCT_FIELDS).join(",");
  const query = `filter.appId=skytta&fields=${encodeURIComponent(fields)}&timestamp=&filter.segment=production`;
  return new URL(`webplanner/v1/query/items/retailunit/${retailUnit}/locale/${locale}?${query}`, baseUrl).href;
}

function normalizeSkyttaProducts(payload, sourceUrl = null) {
  if (!payload || !Array.isArray(payload.data)) throw new Error("The SKYTTA Webplanner response has an unexpected payload");
  const products = new Map();
  const productList = [];
  for (const item of payload.data) {
    const product = normalizeSkyttaProduct(item, sourceUrl);
    if (!product) continue;
    productList.push(product);
    addProductAliases(products, product);
  }
  return { products, productList };
}

function normalizeSkyttaProduct(item, sourceUrl = null) {
  const content = item?.content;
  if (!content || typeof content !== "object") return null;
  const id = firstString(content.ruItemNo, content.itemNoGlobal, stripProductPrefix(item.itemId));
  if (!id) return null;
  return {
    id,
    itemId: firstString(item.itemId, `ART-${id}`),
    valid: item.valid !== false,
    name: content.name || null,
    typeName: content.typeName || content.mainTypeName || null,
    mainTypeName: content.mainTypeName || null,
    dimensionsMm: dimensionsFromMeasures(content.measure),
    genericProduct: Array.isArray(content.genericProduct) ? content.genericProduct : [],
    assets: collectSkyttaAssets(content),
    sourceUrl,
  };
}

function collectSkyttaAssets(content) {
  const assets = [];
  for (const group of Array.isArray(content?.assetV2) ? content.assetV2 : []) {
    for (const model of Array.isArray(group?.model) ? group.model : []) {
      const asset = normalizeAsset({ ...model, code: group.code, name: group.name, rangeFamily: group.rangeFamily }, "assetV2");
      if (asset) assets.push(asset);
    }
  }
  for (const value of Array.isArray(content?.asset) ? content.asset : []) {
    const asset = normalizeAsset(value, "asset");
    if (asset) assets.push(asset);
  }
  const unique = new Map();
  for (const asset of assets) {
    const existing = unique.get(asset.url);
    if (!existing || (existing.source === "asset" && asset.source === "assetV2")) unique.set(asset.url, asset);
  }
  return Array.from(unique.values());
}

function selectSkyttaAsset(product, entityRef, entity = null) {
  const assets = product?.assets || [];
  if (!assets.length) return null;
  if (assets.length === 1) return { ...assets[0], selectionReason: "only-glb-asset" };
  const suffix = entityVariant(entityRef, entity);
  const patterns = suffix === "top"
    ? [/(?:^|[_-])(?:up|upper|top)(?:$|[_-])/i]
    : suffix === "bottom"
      ? [/(?:^|[_-])(?:low|lower|bottom)(?:$|[_-])/i]
      : suffix && suffix !== "default"
        ? [new RegExp(`(?:^|[_-])${escapeRegex(suffix)}(?:$|[_-])`, "i")]
        : [];
  for (const pattern of patterns) {
    const matches = assets.filter((asset) => pattern.test(asset.name || ""));
    if (matches.length === 1) return { ...matches[0], selectionReason: `entity-variant-${suffix}` };
  }
  const exact = assets.filter((asset) => normalizeAssetName(asset.name) === normalizeAssetName(product.id));
  if (exact.length === 1) return { ...exact[0], selectionReason: "product-name-match" };
  return null;
}

function findSkyttaProduct(products, ref) {
  if (!(products instanceof Map) || ref == null) return null;
  const value = String(ref);
  const base = stripEntityVariant(stripProductPrefix(value));
  return products.get(value) || products.get(value.toUpperCase()) || products.get(base) || products.get(base.toUpperCase()) || null;
}

function addProductAliases(products, product) {
  for (const alias of [product.id, product.itemId, stripProductPrefix(product.itemId)].filter(Boolean)) {
    products.set(String(alias), product);
    products.set(String(alias).toUpperCase(), product);
  }
}

function normalizeAsset(value, source) {
  const url = value?.url;
  if (!url || !/\.glb(?:[?#]|$)/i.test(url)) return null;
  if (value.fileTypeName && value.fileTypeName !== "gltf-binary") return null;
  let normalizedUrl;
  try { normalizedUrl = new URL(url).href; } catch { return null; }
  return {
    code: value.code || null,
    name: value.name || null,
    rangeFamily: value.rangeFamily || null,
    levelOfDetail: value.levelOfDetail || null,
    pivot: value.pivot || null,
    url: normalizedUrl,
    modelKey: modelKey(normalizedUrl),
    source,
  };
}

function dimensionsFromMeasures(measures) {
  const dimensions = {};
  for (const measure of Array.isArray(measures) ? measures : []) {
    const value = Number(measure?.value);
    if (!Number.isFinite(value) || String(measure?.unit || "mm").toLowerCase() !== "mm") continue;
    const type = String(measure.typeName || "").toLowerCase();
    if (type === "width" || type === "length") dimensions.width ??= value;
    else if (type === "height") dimensions.height = value;
    else if (type === "depth" || type === "thickness") dimensions.depth ??= value;
  }
  return Object.keys(dimensions).length ? dimensions : null;
}

function entityVariant(ref, entity) {
  const explicit = String(ref || "").match(/--([A-Za-z0-9_-]+)$/)?.[1]?.toLowerCase();
  if (explicit && explicit !== "default") return explicit;
  const railType = Number(entity?.c?.RailComponent?.railType);
  if (railType === 0) return "top";
  if (railType === 1) return "bottom";
  return explicit || null;
}

function stripProductPrefix(value) {
  return value == null ? null : String(value).replace(/^(?:ART|SPR)-/i, "");
}

function stripEntityVariant(value) {
  return value == null ? null : String(value).replace(/--[A-Za-z0-9_-]+$/, "");
}

function normalizeAssetName(value) {
  return String(value || "").replace(/[_-](?:default|rt)$/i, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureTrailingSlash(value) {
  return String(value).endsWith("/") ? String(value) : `${value}/`;
}

module.exports = {
  SKYTTA_PRODUCT_FIELDS,
  addProductAliases,
  collectSkyttaAssets,
  fetchSkyttaProducts,
  findSkyttaProduct,
  normalizeSkyttaProduct,
  normalizeSkyttaProducts,
  selectSkyttaAsset,
  skyttaProductsUrl,
  stripEntityVariant,
  stripProductPrefix,
};
