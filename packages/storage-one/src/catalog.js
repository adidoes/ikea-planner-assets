"use strict";

function extractCatalogProducts(source, sourceUrl = null) {
  const text = String(source || "");
  const products = [];
  let cursor = 0;

  while (cursor < text.length) {
    const marker = text.indexOf("modelURI:", cursor);
    if (marker < 0) break;
    cursor = marker + 9;
    const uriToken = readStringToken(text, skipWhitespace(text, cursor));
    if (!uriToken || !/^https?:\/\//i.test(uriToken.value)) continue;

    const entryStart = text.lastIndexOf("{template:", marker);
    if (entryStart < 0) continue;
    const entryEnd = findBalancedEnd(text, entryStart, "{", "}");
    if (entryEnd < marker) continue;
    const entry = text.slice(entryStart, entryEnd + 1);
    const localMarker = marker - entryStart;
    const afterModel = entry.slice(localMarker);
    const idMatch = afterModel.match(/\bid\s*:\s*([`'"])([^`'"]+)\1/);
    if (!idMatch) continue;

    const product = {
      id: idMatch[2],
      modelUri: uriToken.value,
      modelKey: modelKey(uriToken.value),
      sourceUrl,
      modelTransform: extractModelTransform(entry),
    };
    const dexfMatch = entry.match(/\bdexf\s*:\s*([`'"])([^`'"]*)\1/);
    const typeMatches = Array.from(entry.matchAll(/\btype\s*:\s*([`'"])([^`'"]+)\1/g));
    if (dexfMatch) product.dexf = dexfMatch[2] || null;
    if (typeMatches.length) product.type = typeMatches[typeMatches.length - 1][2];
    products.push(product);
  }

  return dedupeProducts(products);
}

function extractModelTransform(entry) {
  const marker = entry.indexOf("modelTransform:");
  if (marker < 0) return null;
  const start = entry.indexOf("{", marker);
  const end = findBalancedEnd(entry, start, "{", "}");
  if (start < 0 || end < start) return null;
  const source = entry.slice(start, end + 1);
  const transform = {};
  const position = extractVector(source, "p");
  const rotation = extractVector(source, "r");
  const scale = extractVector(source, "s");
  if (position) transform.positionMm = position;
  if (rotation) transform.rotationDegrees = rotation;
  if (scale) transform.scale = scale;
  return Object.keys(transform).length ? transform : null;
}

function extractVector(source, key) {
  const match = source.match(new RegExp(`(?:^|[,\\s{])${key}\\s*:\\s*\\{([^}]*)\\}`));
  if (!match) return null;
  const vector = {};
  for (const axis of ["x", "y", "z"]) {
    const axisMatch = match[1].match(new RegExp(`(?:^|,)\\s*${axis}\\s*:\\s*(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)`));
    if (axisMatch) vector[axis] = Number(axisMatch[1]);
  }
  return Object.keys(vector).length ? vector : null;
}

function modelKey(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "")
      .replace(/\.glb$/i, "")
      .replace(/_opt(?:_[a-z0-9]+)*$/i, "");
  } catch {
    return String(url || "")
      .split(/[/?#]/)
      .pop()
      .replace(/\.glb$/i, "")
      .replace(/_opt(?:_[a-z0-9]+)*$/i, "");
  }
}

function optimizedModelUrl(modelUri) {
  const url = new URL(modelUri);
  url.pathname = url.pathname.replace(/\.glb$/i, "_opt_webp.glb");
  return url.href;
}

function dedupeProducts(products) {
  const unique = new Map();
  for (const product of products) {
    const existing = unique.get(product.id);
    if (!existing || (!existing.modelTransform && product.modelTransform)) unique.set(product.id, product);
  }
  return Array.from(unique.values());
}

function skipWhitespace(text, index) {
  while (/\s/.test(text[index] || "")) index++;
  return index;
}

function readStringToken(text, start) {
  const quote = text[start];
  if (!["`", "'", '"'].includes(quote)) return null;
  let value = "";
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      value += text[i + 1] || "";
      i++;
      continue;
    }
    if (char === quote) return { value, end: i };
    value += char;
  }
  return null;
}

function findBalancedEnd(text, start, open, close) {
  if (start < 0 || text[start] !== open) return -1;
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (["`", "'", '"'].includes(char)) {
      quote = char;
    } else if (char === open) {
      depth++;
    } else if (char === close && --depth === 0) {
      return i;
    }
  }
  return -1;
}

module.exports = {
  extractCatalogProducts,
  extractModelTransform,
  modelKey,
  optimizedModelUrl,
};
