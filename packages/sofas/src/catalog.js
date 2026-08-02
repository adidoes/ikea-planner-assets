"use strict";

function extractSofaCatalog(source, sourceUrl = null) {
  const text = String(source || "");
  const itemsStart = findItemsArray(text);
  if (itemsStart < 0) throw new Error("The sofa catalog module does not contain an items array");
  const itemsEnd = findBalancedEnd(text, itemsStart, "[", "]");
  if (itemsEnd < 0) throw new Error("The sofa catalog items array is incomplete");

  const products = new Map();
  const aliases = new Map();
  let cursor = itemsStart + 1;
  while (cursor < itemsEnd) {
    cursor = skipSpaceAndCommas(text, cursor);
    if (text[cursor] !== "{") {
      cursor++;
      continue;
    }
    const end = findBalancedEnd(text, cursor, "{", "}");
    if (end < 0 || end > itemsEnd) throw new Error("The sofa catalog contains an incomplete item");
    const product = parseCatalogItem(text.slice(cursor, end + 1), sourceUrl);
    if (product?.id) {
      products.set(product.id, product);
      for (const alias of product.historicalIds) aliases.set(alias, product.id);
      if (product.dexfAlias) aliases.set(product.dexfAlias, product.id);
    }
    cursor = end + 1;
  }

  return { products, aliases, sourceUrl };
}

function parseCatalogItem(entry, sourceUrl = null) {
  const id = readStringProperty(entry, "id");
  if (!id) return null;
  const components = readObjectProperty(entry, "components");
  const parameters = readObjectProperty(entry, "parameters");
  const modelTransform = components ? extractModelTransform(components) : null;
  const historicalIds = components ? readStringArrayProperty(components, "historicalIds") : [];
  return {
    id,
    description: readStringProperty(entry, "description"),
    inherits: readStringArrayProperty(entry, "inherits"),
    modelUri: components ? readStringProperty(components, "modelURI") : null,
    modelTransform,
    product: components ? readStringProperty(components, "product") : null,
    dexfAlias: components ? readStringProperty(components, "dexfAlias") : null,
    historicalIds,
    dimensionsMm: parameters ? extractSize(parameters) : null,
    sourceUrl,
  };
}

function resolveCatalogProduct(catalog, id) {
  const products = catalog?.products instanceof Map ? catalog.products : catalog;
  if (!(products instanceof Map)) return null;
  const aliases = catalog?.aliases instanceof Map ? catalog.aliases : new Map();
  const requestedId = String(id || "");
  const canonicalId = products.has(requestedId) ? requestedId : aliases.get(requestedId);
  if (!canonicalId) return null;
  return resolveProduct(products, canonicalId, new Set(), new Map());
}

function resolveProduct(products, id, visiting, cache) {
  if (cache.has(id)) return cache.get(id);
  if (visiting.has(id)) throw new Error(`Circular sofa catalog inheritance at ${id}`);
  const item = products.get(id);
  if (!item) return null;
  visiting.add(id);
  let resolved = { id };
  for (const parentId of item.inherits || []) {
    const parent = resolveProduct(products, parentId, visiting, cache);
    if (parent) resolved = mergeProduct(resolved, parent);
  }
  resolved = mergeProduct(resolved, item);
  visiting.delete(id);
  cache.set(id, resolved);
  return resolved;
}

function mergeProduct(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value != null && (!(Array.isArray(value)) || value.length)) merged[key] = value;
  }
  return merged;
}

function extractModelTransform(components) {
  const transform = readObjectProperty(components, "modelTransform");
  if (!transform) return null;
  const result = {};
  const position = readVectorProperty(transform, "p");
  const rotation = readVectorProperty(transform, "r");
  const scale = readVectorProperty(transform, "s");
  if (position) result.positionMm = position;
  if (rotation) result.rotationDegrees = rotation;
  if (scale) result.scale = scale;
  return Object.keys(result).length ? result : null;
}

function extractSize(parameters) {
  const size = readObjectProperty(parameters, "size");
  if (!size) return null;
  const dimensions = {};
  for (const key of ["width", "height", "depth"]) {
    const value = readNumberProperty(size, key);
    if (value != null) dimensions[key] = value;
  }
  return Object.keys(dimensions).length ? dimensions : null;
}

function readVectorProperty(source, key) {
  const object = readObjectProperty(source, key);
  if (!object) return null;
  const vector = {};
  for (const axis of ["x", "y", "z"]) {
    const value = readNumberProperty(object, axis);
    if (value != null) vector[axis] = value;
  }
  return Object.keys(vector).length ? vector : null;
}

function readStringProperty(source, key) {
  const start = findPropertyValue(source, key);
  if (start < 0 || !["`", "'", '"'].includes(source[start])) return null;
  return readString(source, start)?.value ?? null;
}

function readNumberProperty(source, key) {
  const start = findPropertyValue(source, key);
  if (start < 0) return null;
  const match = source.slice(start).match(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
  return match ? Number(match[0]) : null;
}

function readObjectProperty(source, key) {
  const start = findPropertyValue(source, key);
  if (start < 0 || source[start] !== "{") return null;
  const end = findBalancedEnd(source, start, "{", "}");
  return end < 0 ? null : source.slice(start, end + 1);
}

function readStringArrayProperty(source, key) {
  const start = findPropertyValue(source, key);
  if (start < 0 || source[start] !== "[") return [];
  const end = findBalancedEnd(source, start, "[", "]");
  if (end < 0) return [];
  const values = [];
  let cursor = start + 1;
  while (cursor < end) {
    cursor = skipSpaceAndCommas(source, cursor);
    if (!["`", "'", '"'].includes(source[cursor])) {
      cursor++;
      continue;
    }
    const token = readString(source, cursor);
    if (!token) break;
    values.push(token.value);
    cursor = token.end + 1;
  }
  return values;
}

function findPropertyValue(source, key) {
  if (!source || source[0] !== "{") return -1;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (["`", "'", '"'].includes(char)) {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      continue;
    }
    if (depth !== 1 || !isIdentifierStart(char)) continue;
    const start = i;
    while (isIdentifierPart(source[i + 1])) i++;
    if (source.slice(start, i + 1) !== key) continue;
    let cursor = skipWhitespace(source, i + 1);
    if (source[cursor] !== ":") continue;
    return skipWhitespace(source, cursor + 1);
  }
  return -1;
}

function findItemsArray(source) {
  const marker = /\bitems\s*:/g;
  let match;
  while ((match = marker.exec(source))) {
    const start = skipWhitespace(source, match.index + match[0].length);
    if (source[start] === "[") return start;
  }
  return -1;
}

function findBalancedEnd(source, start, open, close) {
  if (start < 0 || source[start] !== open) return -1;
  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (["`", "'", '"'].includes(char)) quote = char;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) return i;
  }
  return -1;
}

function readString(source, start) {
  const quote = source[start];
  let value = "";
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      const next = source[++i];
      const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };
      value += Object.prototype.hasOwnProperty.call(escapes, next) ? escapes[next] : (next || "");
    } else if (char === quote) {
      return { value, end: i };
    } else {
      value += char;
    }
  }
  return null;
}

function skipSpaceAndCommas(source, index) {
  while (/\s|,/.test(source[index] || "")) index++;
  return index;
}

function skipWhitespace(source, index) {
  while (/\s/.test(source[index] || "")) index++;
  return index;
}

function isIdentifierStart(char) {
  return /[A-Za-z_$]/.test(char || "");
}

function isIdentifierPart(char) {
  return /[A-Za-z0-9_$]/.test(char || "");
}

module.exports = {
  extractModelTransform,
  extractSofaCatalog,
  findBalancedEnd,
  parseCatalogItem,
  resolveCatalogProduct,
};
