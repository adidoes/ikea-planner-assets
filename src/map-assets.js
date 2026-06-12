"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { ensureDir, readJson, writeJson } = require("./common");

async function mapAssets(bmprojPath, manifestPath, options) {
  const project = await readJson(bmprojPath);
  const manifest = await readJson(manifestPath);
  const assets = getManifestAssets(manifest);
  const productCatalog = await loadProductCatalog(assets, options.products || []);
  const metadata = options.metadata ? await readJson(options.metadata) : null;
  const bom = parseBom(metadata);

  const resources = collectProductResourceInfos(project);
  const resourcesByBaseUrl = new Map(resources.map((resource) => [upper(resource.baseURL), resource]));
  const catalogIdsByUuid = buildCatalogIdsByUuid(productCatalog);
  const furnitureRefs = collectFurnitureRefs(project, productCatalog);
  const bomParents = bom ? collectBomParents(bom.products || [], productCatalog) : new Map();

  const mappedAssets = [];
  for (const asset of assets) {
    const cdn = parsePlannerCdnUrl(asset.url);
    if (!cdn) continue;

    const resource = resourcesByBaseUrl.get(upper(cdn.baseURL)) || resourceFromCatalogUuid(cdn.baseURL, catalogIdsByUuid, productCatalog);
    const catalog = resource ? productCatalog[resource.id] : catalogIdsByUuid.get(upper(cdn.baseURL))?.map((id) => productCatalog[id]).find(Boolean);
    const resourceId = resource?.id || catalog?.definition?.id || null;
    const projectOccurrences = resourceId ? (furnitureRefs.byDbId.get(resourceId) || []) : [];
    const directInstances = furnitureRefs.byBaseUrl.get(upper(cdn.baseURL)) || [];
    const parentInstances = mergeInstances(directInstances, projectOccurrences.map((hit) => hit.top).filter(Boolean));
    const bomParentProducts = resourceId ? (bomParents.get(resourceId) || []) : [];

    mappedAssets.push({
      assetFile: asset.bodyPath || null,
      url: asset.url,
      baseURL: cdn.baseURL,
      assetFamily: cdn.family,
      assetName: cdn.fileName,
      bytes: asset.bytes || null,
      sha256: asset.sha256 || null,
      resource: resource ? {
        id: resource.id,
        extensions: resource.extensions,
        path: resource.path,
      } : null,
      catalog: catalog ? catalogSummary(catalog) : null,
      label: catalog ? displayLabel(catalog) : null,
      projectInstances: parentInstances,
      occurrences: projectOccurrences.map((hit) => ({
        path: hit.path,
        paramID: hit.paramID || null,
        top: hit.top,
      })),
      bomParents: bomParentProducts,
    });
  }

  mappedAssets.sort((a, b) => String(a.assetFile || a.url).localeCompare(String(b.assetFile || b.url)));

  const report = {
    schema: "ikea-planner-assets.asset-map.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      bmproj: bmprojPath,
      manifest: manifestPath,
      metadata: options.metadata || null,
      products: options.products || [],
    },
    summary: {
      manifestAssets: assets.length,
      cdnAssets: mappedAssets.length,
      productResourceInfos: resources.length,
      catalogProducts: Object.keys(productCatalog).length,
      mappedWithCatalogLabels: mappedAssets.filter((asset) => asset.catalog).length,
      mappedWithProjectInstances: mappedAssets.filter((asset) => asset.projectInstances.length).length,
    },
    assets: mappedAssets,
  };

  await writeJson(options.out, report);
  if (options.tsv) await writeTsv(options.tsv, mappedAssets);

  console.log(`Mapped ${mappedAssets.length} CDN assets; wrote ${options.out}`);
  if (options.tsv) console.log(`Wrote ${options.tsv}`);
  console.log(JSON.stringify(report.summary, null, 2));
}

function getManifestAssets(manifest) {
  if (Array.isArray(manifest)) return manifest;
  if (Array.isArray(manifest.assets)) return manifest.assets;
  if (Array.isArray(manifest.requests)) return manifest.requests;
  if (Array.isArray(manifest.entries)) return manifest.entries;
  return [];
}

async function loadProductCatalog(assets, explicitPaths) {
  const catalog = {};
  const paths = new Set(explicitPaths);
  for (const asset of assets) {
    if (/\/3\/products\?/i.test(asset.url || "") && asset.bodyPath) {
      paths.add(asset.bodyPath);
    }
  }

  for (const file of paths) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    if (!text || text.trim() === "[]" || text.trim() === "{}") continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const id = item?.definition?.id || item?.id;
        if (id) catalog[id] = item;
      }
    } else {
      Object.assign(catalog, parsed);
    }
  }
  return catalog;
}

function parseBom(metadata) {
  if (!metadata?.appData?.bom) return null;
  if (typeof metadata.appData.bom === "string") return JSON.parse(metadata.appData.bom);
  return metadata.appData.bom;
}

function collectProductResourceInfos(project) {
  const out = [];
  visit(project, (value, pointer) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.id !== "string" || !value.resourceInfo?.baseURL) return;
    out.push({
      id: value.id,
      baseURL: value.resourceInfo.baseURL,
      extensions: value.resourceInfo.extensions || [],
      path: pointer.join("/"),
    });
  });
  return out;
}

function collectFurnitureRefs(project, productCatalog) {
  const byDbId = new Map();
  const byBaseUrl = new Map();
  const furnitures = [];

  visit(project, (value, pointer) => {
    if (!Array.isArray(value) || pointer[pointer.length - 1] !== "furnitures") return;
    value.forEach((item, index) => {
      if (item?.dbId) {
        furnitures.push({
          item,
          path: pointer.concat(index).join("/"),
          top: furnitureSummary(item, pointer.concat(index).join("/"), productCatalog),
        });
      }
    });
  });

  for (const furniture of furnitures) {
    if (furniture.item.resourceInfo?.baseURL) {
      pushMap(byBaseUrl, upper(furniture.item.resourceInfo.baseURL), furniture.top);
    }
    collectDbIdRefs(furniture.item, (hit) => {
      pushMap(byDbId, hit.dbId, {
        path: `${furniture.path}/${hit.path}`,
        paramID: hit.paramID,
        top: furniture.top,
      });
    });
  }

  return { byDbId, byBaseUrl };
}

function collectDbIdRefs(root, onHit) {
  visit(root, (value, pointer) => {
    if (!value || typeof value !== "object" || typeof value.dbId !== "string") return;
    const paramID = nearestParamId(root, pointer);
    onHit({ dbId: value.dbId, path: pointer.join("/"), paramID });
  });
}

function nearestParamId(root, pointer) {
  for (let i = pointer.length - 1; i >= 0; i--) {
    const candidate = getByPointer(root, pointer.slice(0, i + 1));
    if (candidate && typeof candidate === "object" && typeof candidate.paramID === "string") {
      return candidate.paramID;
    }
  }
  return null;
}

function getByPointer(root, pointer) {
  let current = root;
  for (const part of pointer) current = current?.[part];
  return current;
}

function collectBomParents(products, productCatalog) {
  const byChild = new Map();
  for (const product of products) {
    const top = {
      dbId: product.dbID,
      uuid: product.uuid || null,
      nomenclatureNumber: product.nomenclatureNumber || null,
      label: productCatalog[product.dbID] ? displayLabel(productCatalog[product.dbID]) : product.dbID,
    };
    for (const id of collectBomIds(product)) {
      pushMap(byChild, id, top);
    }
  }
  for (const [id, entries] of byChild) byChild.set(id, uniqueObjects(entries, (entry) => `${entry.dbId}|${entry.uuid || ""}|${entry.nomenclatureNumber || ""}`));
  return byChild;
}

function collectBomIds(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (node.dbID) out.add(node.dbID);
  for (const child of node.children || []) collectBomIds(child, out);
  for (const pack of node.packs || []) if (pack.dbID) out.add(pack.dbID);
  return out;
}

function buildCatalogIdsByUuid(productCatalog) {
  const byUuid = new Map();
  for (const [id, product] of Object.entries(productCatalog)) {
    if (product?.bm3UUID) pushMap(byUuid, upper(product.bm3UUID), id);
  }
  return byUuid;
}

function resourceFromCatalogUuid(baseURL, catalogIdsByUuid, productCatalog) {
  const ids = catalogIdsByUuid.get(upper(baseURL)) || [];
  const id = ids[0];
  if (!id) return null;
  return {
    id,
    baseURL,
    extensions: productCatalog[id]?.definition?.geometryExtension || [],
    path: "catalog.bm3UUID",
  };
}

function parsePlannerCdnUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!/cloudfront\.net$/i.test(url.hostname) && !/amazonaws\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || !/^[0-9a-f-]{36}$/i.test(parts[0])) return null;
  return {
    baseURL: parts[0],
    family: parts[1],
    fileName: parts.slice(2).join("/"),
  };
}

function furnitureSummary(item, pointer, productCatalog) {
  const product = productCatalog[item.dbId];
  return {
    dbId: item.dbId,
    uuid: item.uuid || null,
    baseURL: item.resourceInfo?.baseURL || null,
    label: product ? displayLabel(product) : item.dbId,
    path: pointer,
  };
}

function catalogSummary(product) {
  const definition = product.definition || {};
  return {
    id: definition.id || null,
    name: definition.name || null,
    shortDescription: definition.shortDescription || null,
    reference: definition.reference || null,
    languageCode: definition.languageCode || null,
    geometryExtension: definition.geometryExtension || [],
    bm3UUID: product.bm3UUID || null,
  };
}

function displayLabel(product) {
  const definition = product.definition || {};
  return [definition.name, definition.shortDescription].filter(Boolean).join(" - ") || definition.id || product.id || "";
}

async function writeTsv(file, assets) {
  await ensureDir(path.dirname(file));
  const headers = [
    "assetFile",
    "assetName",
    "baseURL",
    "resourceId",
    "label",
    "projectInstances",
    "bomParents",
    "url",
  ];
  const rows = [headers.join("\t")];
  for (const asset of assets) {
    rows.push([
      asset.assetFile || "",
      asset.assetName || "",
      asset.baseURL || "",
      asset.resource?.id || "",
      asset.label || "",
      asset.projectInstances.map((item) => `${item.label} [${item.dbId}]`).join("; "),
      asset.bomParents.map((item) => `${item.label} [${item.dbId}]`).join("; "),
      asset.url || "",
    ].map(tsvCell).join("\t"));
  }
  await fs.writeFile(file, `${rows.join("\n")}\n`);
}

function tsvCell(value) {
  return String(value).replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

function mergeInstances(...groups) {
  return uniqueObjects(groups.flat(), (entry) => `${entry.dbId}|${entry.uuid || ""}|${entry.path || ""}`);
}

function uniqueObjects(values, keyFn) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value) continue;
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function pushMap(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function upper(value) {
  return String(value || "").toUpperCase();
}

function visit(value, onValue, pointer = []) {
  onValue(value, pointer);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, onValue, pointer.concat(index)));
  } else {
    Object.entries(value).forEach(([key, item]) => visit(item, onValue, pointer.concat(key)));
  }
}

module.exports = { mapAssets };
