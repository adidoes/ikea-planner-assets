"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { unzipSync } = require("fflate");
const { ensureDir, readJson, sanitizeFileName, writeJson } = require("./common");

async function assembleInputs(bmprojPath, assetMapPath, options) {
  const project = await readJson(bmprojPath);
  const assetMap = await readJson(assetMapPath);
  const outDir = options.out;
  await ensureDir(outDir);

  const context = {
    project,
    assetMap,
    objDir: options.objDir,
    outDir,
    flat: Boolean(options.flat),
    axis: options.axis || "z-up",
    worktops: Boolean(options.worktops),
    proxyOverFaces: Number.isFinite(options.proxyOverFaces) ? options.proxyOverFaces : 0,
    internalPartsMode: internalPartsMode(options.internalParts),
    scale: Number.isFinite(options.scale) ? options.scale : 0.001,
    resourceById: collectResourceInfos(project),
    assetById: new Map((assetMap.assets || []).filter((asset) => asset.resource?.id).map((asset) => [asset.resource.id, asset])),
    furniture: collectFurniture(project),
    furnitureByUuid: new Map(),
    scalingAreasByAssetFile: new Map(),
    proceduralWorktops: [],
    operationCutouts: [],
    leaves: [],
    skipped: [],
  };
  context.furnitureByUuid = new Map(context.furniture.filter((item) => item.uuid).map((item) => [item.uuid, item]));

  const roots = options.whole ? context.furniture : [selectFurniture(context.furniture, options.instance)];
  if (!roots.length || roots.some((root) => !root)) {
    throw new Error(`No furniture instance matched ${options.instance || "(first furniture)"}`);
  }

  for (const root of roots) {
    await resolveProduct(context, {
      dbId: root.dbId,
      params: Object.assign(
        {},
        paramsFromResource(root.resourceInfo),
        paramsFromConfig(root.parametersConfig),
        paramsFromConfig(root.contextConfig),
      ),
      matrix: rootMatrix(root, options.whole),
      label: root.dbId,
      instance: instanceSummary(context, root),
      trail: [root.dbId],
      depth: 0,
    });
  }
  if (options.whole && context.worktops) {
    context.proceduralWorktops = collectProceduralWorktops(context);
    assignWorktopCutouts(context);
  }

  const root = roots[0];
  const rootLabel = options.whole ? "Complete kitchen" : labelForAsset(context.assetById.get(root.dbId));
  const basename = options.whole
    ? sanitizeFileName(options.name || "Complete kitchen")
    : sanitizeFileName(`${rootLabel || root.dbId}__${root.dbId}_${root.uuid || "assembly"}`);
  const objPath = path.join(outDir, `${basename}.obj`);
  const mtlPath = path.join(outDir, `${basename}.mtl`);
  const outputs = await writeCombinedObj(context, objPath, mtlPath);
  const reportPath = path.join(outDir, `${basename}.assembly-report.json`);
  const report = {
    schema: "ikea-planner-assets.assembly.v1",
    generatedAt: new Date().toISOString(),
    root: {
      mode: options.whole ? "whole" : "instance",
      dbId: options.whole ? null : root.dbId,
      uuid: options.whole ? null : (root.uuid || null),
      label: rootLabel,
      furnitureCount: roots.length,
    },
    outputs,
    summary: {
      leaves: context.leaves.length,
      proceduralWorktops: context.proceduralWorktops.length,
      worktopCornerBridges: context.proceduralWorktops.filter((slab) => slab.cornerBridge).length,
      operationCutouts: context.operationCutouts.length,
      internalLeaves: context.leaves.filter((leaf) => leaf.internalPart).length,
      omittedLeaves: context.leaves.filter((leaf) => leaf.omitted).length,
      proxyLeaves: context.leaves.filter((leaf) => leaf.proxy).length,
      skipped: context.skipped.length,
      maxDepth: Math.max(0, ...context.leaves.map((leaf) => leaf.depth)),
    },
    proceduralWorktops: context.proceduralWorktops,
    operationCutouts: context.operationCutouts,
    placements: roots.map((item) => placementSummary(context, item, options.whole)),
    leaves: context.leaves,
    skipped: context.skipped,
  };
  await writeJson(reportPath, report);
  console.log(`Assembled ${context.leaves.length} BM3 leaves from ${roots.length} furniture item(s); wrote ${objPath}`);
  if (context.skipped.length) console.log(`Skipped ${context.skipped.length} references; see ${reportPath}`);
  return report;
}

async function resolveProduct(context, state) {
  if (!state.dbId || state.depth > 24) {
    if (state.dbId) context.skipped.push({ dbId: state.dbId, reason: "max-depth", trail: state.trail });
    return;
  }
  if (state.trail.slice(0, -1).includes(state.dbId)) {
    context.skipped.push({ dbId: state.dbId, reason: "cycle", trail: state.trail });
    return;
  }

  const asset = context.assetById.get(state.dbId);
  const resource = context.resourceById.get(state.dbId);
  const ext = firstExtension(asset, resource);
  if (!asset) {
    context.skipped.push({ dbId: state.dbId, reason: "no-captured-asset", trail: state.trail });
    return;
  }

  if (ext === ".bm3") {
    const objPath = objPathForAsset(context.objDir, asset.assetFile);
    if (!objPath || !(await exists(objPath))) {
      context.skipped.push({ dbId: state.dbId, reason: "missing-converted-obj", assetFile: asset.assetFile, expectedObj: objPath, trail: state.trail });
      return;
    }
    context.leaves.push({
      dbId: state.dbId,
      label: labelForAsset(asset),
      assetFile: asset.assetFile,
      objPath,
      params: Object.assign({}, paramsFromResource(resource?.resourceInfo), state.params),
      matrix: state.matrix,
      instance: state.instance || null,
      trail: state.trail,
      depth: state.depth,
    });
    return;
  }

  if (ext !== ".bma") {
    context.skipped.push({ dbId: state.dbId, reason: "not-assembly-or-geometry", extension: ext, trail: state.trail });
    return;
  }

  const bma = await readJson(asset.assetFile).catch(() => null);
  if (!bma?.components) {
    context.skipped.push({ dbId: state.dbId, reason: "bma-missing-components", assetFile: asset.assetFile, trail: state.trail });
    return;
  }

  const env = Object.assign({}, paramsFromBma(bma), paramsFromResource(resource?.resourceInfo), state.params);
  evaluateRelations(context, env, bma.relations || [], bma.components || []);
  recordOperationCutout(context, state, asset, env);

  for (const component of bma.components || []) {
    if (!componentIsActive(component, env)) {
      context.skipped.push({
        dbId: state.dbId,
        reason: "inactive-component",
        component: component.name || null,
        activated: component.activated,
        trail: state.trail,
      });
      continue;
    }

    const refValue = component.reference ? env[component.reference] : null;
    const childDbId = dbIdFromValue(refValue);
    if (!childDbId) continue;

    const childParams = {};
    for (const overload of component.overloads || []) {
      childParams[overload.parameter] = evalOverload(overload, env);
    }
    const childMatrix = multiplyMatrices(state.matrix, matrixFromComponent(component, env));
    await resolveProduct(context, {
      dbId: normalizeDbId(childDbId, context.assetById),
      params: childParams,
      matrix: childMatrix,
      label: component.name || childDbId,
      instance: state.instance || null,
      trail: state.trail.concat(childDbId),
      depth: state.depth + 1,
    });
  }
}

function internalPartsMode(value) {
  const mode = String(value || "keep").toLowerCase();
  if (["keep", "proxy", "omit"].includes(mode)) return mode;
  throw new Error(`Expected --internal-parts to be keep, proxy, or omit; got ${value}`);
}

function internalLeafReason(leaf) {
  const label = String(leaf.label || "").toLowerCase();
  const dbId = String(leaf.dbId || "").toLowerCase();
  const partText = `${label} ${dbId}`;

  if (/(front|door|handle|tap|mixer|sink|havs?en|hob|cooktop|oven|microwave|extractor|hood|plinth|chair|table|worktop|cover panel)/.test(partText)) {
    return null;
  }
  if (/(bin with lid|waste sorting|support frame f waste|support frame .*waste)/.test(partText)) {
    return "waste-bin system inside a closed cabinet";
  }
  if (/(pull-out interior fitting|interior fittings|int_fitt_pull-out)/.test(partText)) {
    return "pull-out interior fitting inside a cabinet";
  }
  if (/(^|\s)maximera - drawer,|drawer, (low|medium|high), white|ma_drwr_|inner drawer|innerdrawer/.test(partText)) {
    return "drawer box or inner drawer hidden behind fronts";
  }
  if (/(fixed .*shelf|ventilated shelf|shelf, white|shelf protector|utrusta - fixed)/.test(partText)) {
    return "internal cabinet shelf";
  }
  if (/(connecting rail for fronts|våglig|vaglig)/.test(partText)) {
    return "internal rail behind integrated appliance fronts";
  }
  if (/(integrated dishwasher|fridge\/freezer.*integrated|fridge freezer.*integrated|ikea 500 integrated)/.test(partText)) {
    return "integrated appliance hidden behind cabinet fronts";
  }
  return null;
}

async function writeCombinedObj(context, objPath, mtlPath) {
  const obj = [
    "# Composed ByMe BMA assembly by ikea-planner-assets",
    `mtllib ${path.basename(mtlPath)}`,
    context.flat ? "o kitchen" : null,
  ];
  const mtl = ["# Materials merged by ikea-planner-assets"];
  let vertexBase = 0;
  let uvBase = 0;
  let normalBase = 0;
  const proxyMaterials = new Map();

  for (let i = 0; i < context.leaves.length; i++) {
    const leaf = context.leaves[i];
    const prefix = `p${i}_${sanitizeObjName(leaf.instance?.label || leaf.dbId)}_${sanitizeObjName(leaf.dbId)}`;
    const source = await fs.readFile(leaf.objPath, "utf8");
    const sourceDir = path.dirname(leaf.objPath);
    const fit = await fitForLeaf(context, leaf, source);
    const sourceStats = objStats(source);
    const localCounts = { v: 0, vt: 0, vn: 0 };
    if (fit?.report) leaf.fit = fit.report;
    const internalReason = internalLeafReason(leaf);
    if (internalReason) {
      leaf.internalPart = { reason: internalReason, mode: context.internalPartsMode };
      if (context.internalPartsMode === "omit") {
        leaf.omitted = {
          reason: `internal part omitted: ${internalReason}`,
          sourceFaces: sourceStats.f,
          sourceVertices: sourceStats.v,
        };
        continue;
      }
    }
    const proxyReason = internalReason && context.internalPartsMode === "proxy"
      ? `internal part proxied: ${internalReason}`
      : (context.proxyOverFaces > 0 && sourceStats.f > context.proxyOverFaces
          ? `source faces ${sourceStats.f} > threshold ${context.proxyOverFaces}`
          : null);
    if (proxyReason) {
      const material = proxyMaterialForLeaf(leaf);
      if (!proxyMaterials.has(material.name)) {
        proxyMaterials.set(material.name, material);
        mtl.push("");
        mtl.push(`newmtl ${material.name}`);
        mtl.push(`Kd ${material.color.join(" ")}`);
        mtl.push("Ks 0.08 0.08 0.08");
        mtl.push("Ns 20");
        mtl.push("d 1");
      }
      leaf.proxy = {
        reason: proxyReason,
        sourceFaces: sourceStats.f,
        sourceVertices: sourceStats.v,
        material: material.name,
      };
      const counts = appendLeafProxy(obj, leaf, source, fit, material.name, vertexBase, uvBase, normalBase, context);
      vertexBase += counts.v;
      uvBase += counts.vt;
      normalBase += counts.vn;
      continue;
    }

    obj.push("");
    if (!context.flat) obj.push(`g ${prefix}`);
    if (leaf.instance) obj.push(`# Instance: ${leaf.instance.label} ${leaf.instance.uuid || ""}`);
    obj.push(`# Part: ${leaf.label}`);

    for (const line of source.split(/\r?\n/)) {
      if (!line || line.startsWith("#") || line.startsWith("mtllib ")) continue;
      if (context.flat && (line.startsWith("o ") || line.startsWith("g "))) {
        continue;
      } else if (line.startsWith("o ") || line.startsWith("g ")) {
        obj.push(`o ${prefix}_${sanitizeObjName(line.slice(2).trim())}`);
      } else if (line.startsWith("usemtl ")) {
        obj.push(`usemtl ${prefix}_${sanitizeObjName(line.slice(7).trim())}`);
      } else if (line.startsWith("v ")) {
        localCounts.v++;
        const p = line.split(/\s+/).slice(1, 4).map(Number);
        const t = orientPoint(transformExportedPoint(leaf.matrix, fit ? fitPoint(p, fit) : p, context.scale), context.axis);
        obj.push(`v ${t[0]} ${t[1]} ${t[2]}`);
      } else if (line.startsWith("vt ")) {
        localCounts.vt++;
        obj.push(line);
      } else if (line.startsWith("vn ")) {
        localCounts.vn++;
        const n = orientVector(normalize(transformVector(leaf.matrix, line.split(/\s+/).slice(1, 4).map(Number))), context.axis);
        obj.push(`vn ${n[0]} ${n[1]} ${n[2]}`);
      } else if (line.startsWith("f ")) {
        obj.push(rebaseFace(line, vertexBase, uvBase, normalBase));
      }
    }

    const mtllibs = Array.from(source.matchAll(/^mtllib\s+(.+)$/gm)).map((match) => match[1].trim());
    for (const lib of mtllibs) {
      const mtlSource = path.join(sourceDir, lib);
      const text = await fs.readFile(mtlSource, "utf8").catch(() => "");
      if (text) mtl.push(rewriteMtl(text, prefix, sourceDir, path.dirname(mtlPath)));
    }

    vertexBase += localCounts.v;
    uvBase += localCounts.vt;
    normalBase += localCounts.vn;
  }

  if (context.proceduralWorktops.length) {
    const material = await worktopMaterial(context, path.dirname(mtlPath));
    mtl.push("");
    mtl.push(`newmtl ${material.name}`);
    mtl.push(`Ka ${material.color.join(" ")}`);
    mtl.push(`Kd ${material.color.join(" ")}`);
    mtl.push("Ks 0.196078 0.196078 0.196078");
    mtl.push("illum 2");
    mtl.push("Ns 100");
    mtl.push("d 1");
    if (material.texture) mtl.push(`map_Kd ${material.texture}`);
    for (const slab of context.proceduralWorktops) {
      const counts = appendWorktopSlab(obj, slab, material, vertexBase, uvBase, normalBase, context);
      vertexBase += counts.v;
      uvBase += counts.vt;
      normalBase += counts.vn;
    }
  }

  await fs.writeFile(objPath, `${obj.join("\n")}\n`);
  await fs.writeFile(mtlPath, `${mtl.join("\n")}\n`);
  await materializeMtlTextures(mtlPath);
  return { obj: objPath, mtl: mtlPath };
}

function collectResourceInfos(project) {
  const out = new Map();
  visit(project, (value) => {
    if (value?.id && value.resourceInfo?.baseURL) out.set(value.id, value);
  });
  return out;
}

function collectFurniture(project) {
  const out = [];
  visit(project, (value, pointer) => {
    if (Array.isArray(value) && pointer[pointer.length - 1] === "furnitures") {
      value.forEach((item, index) => {
        if (item?.dbId) out.push(Object.assign({ path: pointer.concat(index).join("/") }, item));
      });
    }
  });
  return out;
}

function collectWorktopLinears(project) {
  const out = [];
  visit(project, (value) => {
    if (Array.isArray(value?.worktops)) out.push(...value.worktops);
  });
  const seen = new Set();
  return out.filter((worktop) => {
    if (!worktop?.uuid || seen.has(worktop.uuid)) return false;
    seen.add(worktop.uuid);
    return Array.isArray(worktop.furnitureIDs) && worktop.furnitureIDs.length;
  });
}

function collectProceduralWorktops(context) {
  const slabs = [];
  for (const worktop of collectWorktopLinears(context.project)) {
    slabs.push(...slabsForWorktop(context, worktop));
  }
  normalizeWorktopOverlaps(slabs);
  addWorktopCornerBridges(slabs);
  return slabs;
}

function normalizeWorktopOverlaps(slabs) {
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 0; i < slabs.length; i++) {
      for (let j = i + 1; j < slabs.length; j++) {
        changed = trimWorktopOverlap(slabs[i], slabs[j]) || changed;
      }
    }
    if (!changed) break;
  }
  for (const slab of slabs) refreshWorktopSlabGeometry(slab);
}

function trimWorktopOverlap(a, b) {
  if (a.orientation !== b.orientation || Math.abs((a.altitude || 0) - (b.altitude || 0)) > 0.1) return false;
  if (!a.primary || !a.secondary || !b.primary || !b.secondary) return false;
  const overlapU = rangeOverlap(a.primary, b.primary);
  const overlapV = rangeOverlap(a.secondary, b.secondary);
  if (overlapU <= 0 || overlapV <= 0) return false;
  let changed = false;
  if (overlapV <= 80 && overlapU > 80) {
    const centerA = (a.secondary.min + a.secondary.max) / 2;
    const centerB = (b.secondary.min + b.secondary.max) / 2;
    const split = (Math.max(a.secondary.min, b.secondary.min) + Math.min(a.secondary.max, b.secondary.max)) / 2;
    if (centerA <= centerB) {
      a.secondary.max = Math.min(a.secondary.max, split);
      b.secondary.min = Math.max(b.secondary.min, split);
    } else {
      b.secondary.max = Math.min(b.secondary.max, split);
      a.secondary.min = Math.max(a.secondary.min, split);
    }
    changed = true;
  } else if (overlapU <= 80 && overlapV > 80) {
    const centerA = (a.primary.min + a.primary.max) / 2;
    const centerB = (b.primary.min + b.primary.max) / 2;
    const split = (Math.max(a.primary.min, b.primary.min) + Math.min(a.primary.max, b.primary.max)) / 2;
    if (centerA <= centerB) {
      a.primary.max = Math.min(a.primary.max, split);
      b.primary.min = Math.max(b.primary.min, split);
    } else {
      b.primary.max = Math.min(b.primary.max, split);
      a.primary.min = Math.max(a.primary.min, split);
    }
    changed = true;
  }
  if (changed) {
    a.overlapFixes = (a.overlapFixes || 0) + 1;
    b.overlapFixes = (b.overlapFixes || 0) + 1;
  }
  return changed;
}

function addWorktopCornerBridges(slabs) {
  const bridges = [];
  const seen = new Set();
  for (let i = 0; i < slabs.length; i++) {
    for (let j = i + 1; j < slabs.length; j++) {
      const bridge = worktopCornerBridge(slabs[i], slabs[j], bridges.length + 1);
      if (!bridge) continue;
      const key = [
        bridge.primary.min.toFixed(3),
        bridge.primary.max.toFixed(3),
        bridge.secondary.min.toFixed(3),
        bridge.secondary.max.toFixed(3),
        bridge.altitude.toFixed(3),
      ].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      bridges.push(bridge);
    }
  }
  slabs.push(...bridges);
}

function worktopCornerBridge(a, b, index) {
  if (a.orientation === b.orientation) return null;
  if (Math.abs((a.altitude || 0) - (b.altitude || 0)) > 0.1) return null;
  if (Math.abs((a.thickness || 0) - (b.thickness || 0)) > 0.1) return null;
  if (a.materialDbId && b.materialDbId && a.materialDbId !== b.materialDbId) return null;

  const rectA = worktopWorldRect(a);
  const rectB = worktopWorldRect(b);
  const xOverlap = overlapRange(rectA.x, rectB.x);
  const yOverlap = overlapRange(rectA.y, rectB.y);
  const xGap = gapRange(rectA.x, rectB.x);
  const yGap = gapRange(rectA.y, rectB.y);
  const maxJoinGap = 120;
  const minSharedEdge = 100;
  const minBridgeWidth = 5;
  let primary = null;
  let secondary = null;

  if (xOverlap.size >= minSharedEdge && yGap && yGap.size <= maxJoinGap) {
    primary = { min: xOverlap.min, max: xOverlap.max };
    secondary = { min: yGap.min, max: yGap.max };
  } else if (yOverlap.size >= minSharedEdge && xGap && xGap.size <= maxJoinGap) {
    primary = { min: xGap.min, max: xGap.max };
    secondary = { min: yOverlap.min, max: yOverlap.max };
  }
  if (!primary || !secondary) return null;
  if (primary.max - primary.min < minBridgeWidth || secondary.max - secondary.min < minBridgeWidth) return null;

  const axes = canonicalAxes("x");
  return {
    uuid: `${a.uuid || "worktop"}__corner_bridge_${index}`,
    materialDbId: a.materialDbId || b.materialDbId || null,
    label: `Worktop corner bridge ${index}`,
    altitude: Number(a.altitude) || Number(b.altitude) || 882,
    thickness: Number(a.thickness) || Number(b.thickness) || 20,
    orientation: "x",
    furnitureIDs: uniqueStrings([...(a.furnitureIDs || []), ...(b.furnitureIDs || [])]),
    sourceFurnitureIDs: uniqueStrings([...(a.sourceFurnitureIDs || []), ...(b.sourceFurnitureIDs || [])]),
    size: {
      width: primary.max - primary.min,
      depth: secondary.max - secondary.min,
      thickness: Number(a.thickness) || Number(b.thickness) || 20,
    },
    axes,
    primary,
    secondary,
    cutouts: [],
    points: rectanglePoints(axes.u, axes.v, primary, secondary),
    cornerBridge: true,
    bridgeReason: "small perpendicular worktop join gap",
    sourceSlabs: [a.label || a.uuid || null, b.label || b.uuid || null].filter(Boolean),
  };
}

function worktopWorldRect(slab) {
  const points = slab.points?.length ? slab.points : rectanglePoints(
    (slab.axes || axesFromOrientation(slab.orientation)).u,
    (slab.axes || axesFromOrientation(slab.orientation)).v,
    slab.primary,
    slab.secondary,
  );
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    x: { min: Math.min(...xs), max: Math.max(...xs) },
    y: { min: Math.min(...ys), max: Math.max(...ys) },
  };
}

function rangeOverlap(a, b) {
  return Math.min(a.max, b.max) - Math.max(a.min, b.min);
}

function overlapRange(a, b) {
  const min = Math.max(a.min, b.min);
  const max = Math.min(a.max, b.max);
  return { min, max, size: Math.max(0, max - min) };
}

function gapRange(a, b) {
  if (a.max < b.min) return { min: a.max, max: b.min, size: b.min - a.max };
  if (b.max < a.min) return { min: b.max, max: a.min, size: a.min - b.max };
  return null;
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function refreshWorktopSlabGeometry(slab) {
  const axes = slab.axes || axesFromOrientation(slab.orientation);
  slab.size.width = slab.primary.max - slab.primary.min;
  slab.size.depth = slab.secondary.max - slab.secondary.min;
  slab.points = rectanglePoints(axes.u, axes.v, slab.primary, slab.secondary);
}

function slabsForWorktop(context, worktop) {
  const items = worktop.furnitureIDs
    .map((uuid) => context.furnitureByUuid.get(uuid))
    .filter(Boolean)
    .map((item) => Object.assign(worktopFootprint(item), {
      uuid: item.uuid,
      dbId: item.dbId,
      label: labelForAsset(context.assetById.get(item.dbId)) || item.dbId,
      params: Object.assign({}, paramsFromResource(item.resourceInfo), paramsFromConfig(item.parametersConfig), paramsFromConfig(item.contextConfig)),
    }))
    .filter((item) => item.width > 0 && item.depth > 0);
  if (!items.length) return [];

  const byOrientation = new Map();
  for (const item of items) {
    const key = orientationKey(item.xAxis);
    if (!byOrientation.has(key)) byOrientation.set(key, []);
    byOrientation.get(key).push(item);
  }
  const dominantCount = Math.max(...Array.from(byOrientation.values()).map((group) => group.length));
  const hasCorner = byOrientation.size > 1;
  const slabs = [];

  for (const [key, oriented] of byOrientation) {
    const axes = canonicalAxes(key, oriented[0]);
    const clusters = clusterBySecondaryCenter(oriented, axes.v);
    const cluster = clusters.sort((a, b) => clusterScore(b, axes.u) - clusterScore(a, axes.u))[0];
    if (!cluster?.length) continue;

    const primaryItems = hasCorner && oriented.length === dominantCount ? items : cluster;
    const primary = extentAlong(primaryItems, axes.u);
    const depth = median(cluster.map((item) => item.depth)) || Number(worktop.parameters?.depth?.value) || 635;
    const targetDepth = depth + 35;
    const secondaryCenter = median(cluster.map((item) => dot2(item.center, axes.v)));
    const secondary = { min: secondaryCenter - targetDepth / 2, max: secondaryCenter + targetDepth / 2 };
    const startOverhang = Number(worktop.startOverhang) || 0;
    const endOverhang = Number(worktop.endOverhang) || 0;
    primary.min -= startOverhang;
    primary.max += endOverhang;

    slabs.push({
      uuid: worktop.uuid,
      materialDbId: worktop.productInfoDbId || null,
      label: `Worktop ${slabs.length + 1}`,
      altitude: Number(worktop.altitude) || 882,
      thickness: Number(worktop.thickness) || 20,
      orientation: key,
      furnitureIDs: cluster.map((item) => item.uuid),
      sourceFurnitureIDs: worktop.furnitureIDs,
      size: {
        width: primary.max - primary.min,
        depth: secondary.max - secondary.min,
        thickness: Number(worktop.thickness) || 20,
      },
      axes,
      primary: Object.assign({}, primary),
      secondary: Object.assign({}, secondary),
      cutouts: [],
      points: rectanglePoints(axes.u, axes.v, primary, secondary),
    });
  }
  return slabs;
}

function recordOperationCutout(context, state, asset, env) {
  const label = labelForAsset(asset) || state.dbId || "";
  const lower = label.toLowerCase();
  let kind = null;
  if (lower.includes("hob cutout")) kind = "hob";
  else if (lower.includes("sink cutout")) kind = "sink";
  else if (lower.includes("tap cutout")) kind = "tap";
  if (!kind) return;

  const matrix = state.matrix || identityMatrix();
  const width = numericParameter(env.width) || numericParameter(env.diameter) || 0;
  const depth = numericParameter(env.depth) || numericParameter(env.diameter) || width;
  const diameter = numericParameter(env.diameter) || 0;
  const center = [matrix[12] || 0, matrix[13] || 0];
  const xAxis = normalizeVector([matrix[0], matrix[1], 0], [1, 0, 0]);
  const yAxis = normalizeVector([matrix[4], matrix[5], 0], [0, 1, 0]);

  context.operationCutouts.push({
    kind,
    dbId: state.dbId,
    label,
    center,
    xAxis,
    yAxis,
    width: kind === "tap" ? diameter : width,
    depth: kind === "tap" ? diameter : depth,
    diameter: kind === "tap" ? diameter : null,
    radius: numericParameter(env.radius) || null,
    worktopGroup: numericParameter(env.worktopGroup) || 0,
    matrix,
    trail: state.trail,
  });
}

function assignWorktopCutouts(context) {
  for (const slab of context.proceduralWorktops) slab.cutouts = [];
  for (const cutout of context.operationCutouts) {
    const candidates = context.proceduralWorktops
      .map((slab) => ({ slab, rect: cutoutRectForSlab(cutout, slab) }))
      .filter((entry) => entry.rect)
      .sort((a, b) => rectArea(b.rect) - rectArea(a.rect));
    if (!candidates.length) continue;
    candidates[0].slab.cutouts.push(candidates[0].rect);
  }
}

function cutoutRectForSlab(cutout, slab) {
  const axes = slab.axes || axesFromOrientation(slab.orientation);
  const primary = slab.primary || extentOfPoints(slab.points, axes.u);
  const secondary = slab.secondary || extentOfPoints(slab.points, axes.v);
  const centerU = dot2(cutout.center, axes.u);
  const centerV = dot2(cutout.center, axes.v);
  if (
    centerU < primary.min - 5 || centerU > primary.max + 5 ||
    centerV < secondary.min - 5 || centerV > secondary.max + 5
  ) return null;

  const width = Math.max(1, cutout.width || cutout.diameter || 0);
  const depth = Math.max(1, cutout.depth || cutout.diameter || width);
  const halfU = Math.abs(dot2(cutout.xAxis, axes.u)) * width / 2 + Math.abs(dot2(cutout.yAxis, axes.u)) * depth / 2;
  const halfV = Math.abs(dot2(cutout.xAxis, axes.v)) * width / 2 + Math.abs(dot2(cutout.yAxis, axes.v)) * depth / 2;
  const margin = cutout.kind === "tap" ? 6 : 0;
  const rect = {
    kind: cutout.kind,
    dbId: cutout.dbId,
    label: cutout.label,
    center: cutout.center,
    localCenter: { u: centerU, v: centerV },
    minU: Math.max(primary.min + 1, centerU - halfU - margin),
    maxU: Math.min(primary.max - 1, centerU + halfU + margin),
    minV: Math.max(secondary.min + 1, centerV - halfV - margin),
    maxV: Math.min(secondary.max - 1, centerV + halfV + margin),
    source: cutout,
  };
  if (rect.maxU - rect.minU < 5 || rect.maxV - rect.minV < 5) return null;
  return rect;
}

function rectArea(rect) {
  return Math.max(0, rect.maxU - rect.minU) * Math.max(0, rect.maxV - rect.minV);
}

function extentOfPoints(points, axis) {
  const out = { min: Infinity, max: -Infinity };
  for (const point of points || []) {
    const value = dot2(point, axis);
    out.min = Math.min(out.min, value);
    out.max = Math.max(out.max, value);
  }
  return out;
}

function worktopFootprint(item) {
  const params = Object.assign({}, paramsFromResource(item.resourceInfo), paramsFromConfig(item.parametersConfig), paramsFromConfig(item.contextConfig));
  const matrix = item.transfo || identityMatrix();
  const xAxis = normalizeVector([matrix[0], matrix[1], 0], [1, 0, 0]);
  const yAxis = normalizeVector([matrix[4], matrix[5], 0], [0, 1, 0]);
  const center = [matrix[12] || 0, matrix[13] || 0];
  const width = numericParameter(params.width) || bboxSize(item.boundingBox, "x") || 0;
  const depth = numericParameter(params.depth) || bboxSize(item.boundingBox, "y") || 0;
  return { center, xAxis, yAxis, width, depth };
}

function bboxSize(box, axis) {
  if (!box?.min || !box?.max) return 0;
  return Math.abs((box.max[axis] || 0) - (box.min[axis] || 0));
}

function orientationKey(axis) {
  return Math.abs(axis[0]) >= Math.abs(axis[1]) ? "x" : "y";
}

function canonicalAxes(key) {
  return key === "x"
    ? { u: [1, 0], v: [0, 1] }
    : { u: [0, 1], v: [-1, 0] };
}

function clusterBySecondaryCenter(items, secondaryAxis) {
  const sorted = items.slice().sort((a, b) => dot2(a.center, secondaryAxis) - dot2(b.center, secondaryAxis));
  const clusters = [];
  for (const item of sorted) {
    const value = dot2(item.center, secondaryAxis);
    const current = clusters[clusters.length - 1];
    if (current && Math.abs(value - median(current.map((entry) => dot2(entry.center, secondaryAxis)))) <= 120) current.push(item);
    else clusters.push([item]);
  }
  return clusters;
}

function clusterScore(items, primaryAxis) {
  return items.length * 100000 + (extentAlong(items, primaryAxis).max - extentAlong(items, primaryAxis).min);
}

function extentAlong(items, axis) {
  const out = { min: Infinity, max: -Infinity };
  for (const item of items) {
    for (const point of footprintCorners(item)) {
      const value = dot2(point, axis);
      out.min = Math.min(out.min, value);
      out.max = Math.max(out.max, value);
    }
  }
  return out;
}

function footprintCorners(item) {
  const x = mul2(item.xAxis, item.width / 2);
  const y = mul2(item.yAxis, item.depth / 2);
  return [
    add2(add2(item.center, x), y),
    add2(add2(item.center, x), mul2(y, -1)),
    add2(add2(item.center, mul2(x, -1)), y),
    add2(add2(item.center, mul2(x, -1)), mul2(y, -1)),
  ];
}

function rectanglePoints(u, v, primary, secondary) {
  return [
    add2(mul2(u, primary.min), mul2(v, secondary.min)),
    add2(mul2(u, primary.max), mul2(v, secondary.min)),
    add2(mul2(u, primary.max), mul2(v, secondary.max)),
    add2(mul2(u, primary.min), mul2(v, secondary.max)),
  ];
}

function add2(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

function mul2(a, scale) {
  return [a[0] * scale, a[1] * scale];
}

function dot2(a, b) {
  return a[0] * b[0] + a[1] * b[1];
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function selectFurniture(furniture, selector) {
  if (!selector) return furniture[0];
  return furniture.find((item) => item.uuid === selector || item.dbId === selector || `${item.dbId}:${item.uuid}` === selector);
}

function rootMatrix(root, whole) {
  return whole && Array.isArray(root.transfo) && root.transfo.length === 16 ? root.transfo : identityMatrix();
}

function instanceSummary(context, root) {
  const asset = context.assetById.get(root.dbId);
  return {
    dbId: root.dbId,
    uuid: root.uuid || null,
    label: labelForAsset(asset) || root.dbId,
    path: root.path || null,
  };
}

function placementSummary(context, root, whole) {
  const asset = context.assetById.get(root.dbId);
  return {
    dbId: root.dbId,
    uuid: root.uuid || null,
    label: labelForAsset(asset) || root.dbId,
    path: root.path || null,
    matrix: rootMatrix(root, whole),
    localBoundingBox: root.boundingBox || null,
    worldBoundingBox: root.boundingBox ? transformBoundingBox(root.boundingBox, rootMatrix(root, whole)) : null,
  };
}

function transformBoundingBox(box, matrix) {
  const corners = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        corners.push(transformPointMm(matrix, [x, y, z]));
      }
    }
  }
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const [x, y, z] of corners) {
    min.x = Math.min(min.x, x); min.y = Math.min(min.y, y); min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x); max.y = Math.max(max.y, y); max.z = Math.max(max.z, z);
  }
  return {
    min,
    max,
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (max.x + min.x) / 2, y: (max.y + min.y) / 2, z: (max.z + min.z) / 2 },
  };
}

function transformPointMm(m, p) {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function paramsFromBma(bma) {
  const params = {};
  for (const param of bma.parameters || []) params[param.name] = param.value ?? null;
  return params;
}

function paramsFromResource(resourceInfo) {
  const params = {};
  for (const param of resourceInfo?.parameters || []) params[param.id] = param.value ?? null;
  return params;
}

function paramsFromConfig(parametersConfig) {
  const params = {};
  for (const param of parametersConfig || []) params[param.paramID] = param.value ?? null;
  return params;
}

function componentIsActive(component, env) {
  if (!Object.prototype.hasOwnProperty.call(component, "activated")) return true;
  const value = evalExpression(component.activated, env);
  return value === undefined ? true : Boolean(value);
}

function evaluateRelations(context, env, relations, components) {
  env.Pi = Math.PI;
  env.Pi_2 = Math.PI / 2;
  env.Pi_4 = Math.PI / 4;
  let changed = true;
  for (let pass = 0; pass < 10 && changed; pass++) {
    changed = false;
    populateComponentDependencyObjects(context, env, relations, components);
    for (const relation of relations) {
      if (!relation.name || typeof relation.expression !== "string") continue;
      const value = evalExpression(relation.expression, env);
      if (value !== undefined && env[relation.name] !== value) {
        env[relation.name] = value;
        changed = true;
      }
    }
  }
}

function evalOverload(overload, env) {
  if (typeof overload.value === "string") {
    if (Object.prototype.hasOwnProperty.call(env, overload.value)) return env[overload.value];
    const evaluated = evalExpression(overload.value, env);
    return evaluated === undefined ? overload.value : evaluated;
  }
  return overload.value ?? null;
}

function evalExpression(value, env) {
  if (typeof value === "number") return value;
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value !== "string") return 0;
  const trimmed = value.replace(/\u00a0/g, " ").trim();
  if (!trimmed) return undefined;
  if (Object.prototype.hasOwnProperty.call(env, trimmed)) return env[trimmed];
  if (!/^[A-Za-z0-9_$+\-*/().\s?:=!<>&|,'"]+$/.test(trimmed)) return undefined;
  try {
    const names = expressionIdentifiers(trimmed, env);
    const args = names.map((key) => env[key]);
    const result = Function("Math", ...names, `"use strict"; return (${trimmed});`)(Math, ...args);
    if (typeof result === "number" && !Number.isFinite(result)) return undefined;
    return result;
  } catch {
    return undefined;
  }
}

function expressionIdentifiers(expression, env) {
  const reserved = new Set(["Math", "null", "true", "false", "undefined", "NaN", "Infinity"]);
  const names = [];
  const seen = new Set();
  for (const match of expression.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const name = match[0];
    const previous = expression[match.index - 1];
    if (previous === "." || reserved.has(name) || seen.has(name)) continue;
    seen.add(name);
    if (!Object.prototype.hasOwnProperty.call(env, name)) env[name] = 0;
    names.push(name);
  }
  return names;
}

function populateComponentDependencyObjects(context, env, relations, components) {
  const byName = new Map((components || []).map((component) => [component.name, component]));
  for (const relation of relations || []) {
    for (const dependency of relation.componentDependencies || []) {
      const name = dependency.componentName || dependency.component;
      if (!name) continue;
      const component = byName.get(dependency.component) || byName.get(name);
      env[name] = component ? componentProperties(context, env, component) : null;
    }
  }
}

function componentProperties(context, env, component) {
  const refValue = component.reference ? env[component.reference] : null;
  const dbId = normalizeDbId(dbIdFromValue(refValue), context.assetById);
  if (!dbId) return null;
  const resource = context.resourceById.get(dbId);
  const props = Object.assign({}, paramsFromResource(resource?.resourceInfo));
  const box = resource?.resourceInfo?.boundingBox;
  if (box?.min && box?.max) {
    props.width = props.width ?? Math.abs(box.max.x - box.min.x);
    props.depth = props.depth ?? Math.abs(box.max.y - box.min.y);
    props.height = props.height ?? Math.abs(box.max.z - box.min.z);
  }
  props.dbId = dbId;
  return props;
}

function matrixFromComponent(component, env) {
  const y = normalizeVector(vectorFrom(component.directionY || { x: 0, y: 1, z: 0 }, env), [0, 1, 0]);
  const z = normalizeVector(vectorFrom(component.directionZ || { x: 0, y: 0, z: 1 }, env), [0, 0, 1]);
  const x = normalizeVector(cross(y, z), [1, 0, 0]);
  const p = vectorFrom(component.position || { x: 0, y: 0, z: 0 }, env);
  return [
    x[0], x[1], x[2], 0,
    y[0], y[1], y[2], 0,
    z[0], z[1], z[2], 0,
    p[0], p[1], p[2], 1,
  ];
}

function vectorFrom(value, env) {
  return [
    numeric(evalExpression(Object.prototype.hasOwnProperty.call(value, "x") ? value.x : 0, env)),
    numeric(evalExpression(Object.prototype.hasOwnProperty.call(value, "y") ? value.y : 0, env)),
    numeric(evalExpression(Object.prototype.hasOwnProperty.call(value, "z") ? value.z : 0, env)),
  ];
}

function dbIdFromValue(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.dbId || value.referenceValue?.dbId || null;
}

function normalizeDbId(dbId, assetById) {
  if (assetById.has(dbId)) return dbId;
  const match = String(dbId).match(/^(.*)-([A-Z]{2})$/);
  if (!match) return dbId;
  for (const id of assetById.keys()) {
    if (id.startsWith(`${match[1]}-`)) return id;
  }
  return dbId;
}

function firstExtension(asset, resource) {
  return (asset?.resource?.extensions?.[0] || resource?.resourceInfo?.extensions?.[0] || "").toLowerCase();
}

function objPathForAsset(objDir, assetFile) {
  if (!assetFile) return null;
  return path.join(objDir, `${path.basename(assetFile, path.extname(assetFile))}.obj`);
}

function rebaseFace(line, vertexBase, uvBase, normalBase) {
  return line.replace(/(\d+)(?:\/(\d*)?(?:\/(\d+))?)?/g, (_match, v, vt, vn) => {
    const nv = Number(v) + vertexBase;
    const nvt = vt ? Number(vt) + uvBase : vt;
    const nvn = vn ? Number(vn) + normalBase : vn;
    if (vn) return `${nv}/${nvt || ""}/${nvn}`;
    if (vt !== undefined) return `${nv}/${nvt || ""}`;
    return `${nv}`;
  });
}

function rewriteMtl(text, prefix, sourceDir, outDir) {
  return text.split(/\r?\n/).map((line) => {
    if (line.startsWith("newmtl ")) return `newmtl ${prefix}_${sanitizeObjName(line.slice(7).trim())}`;
    if (line.startsWith("map_Kd ")) {
      const texture = line.slice(7).trim();
      const abs = path.resolve(sourceDir, texture);
      return `map_Kd ${path.relative(outDir, abs).replace(/\\/g, "/")}`;
    }
    return line;
  }).join("\n");
}

function appendLeafProxy(obj, leaf, source, fit, materialName, vertexBase, uvBase, normalBase, context) {
  const box = objBoundingBox(source);
  if (!box) return { v: 0, vt: 0, vn: 0 };
  const corners = [];
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) {
        corners.push(orientPoint(transformExportedPoint(leaf.matrix, fit ? fitPoint([x, y, z], fit) : [x, y, z], context.scale), context.axis));
      }
    }
  }
  const faces = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const normals = faces.map((face) => normalForQuad(face.map((index) => corners[index])));

  obj.push("");
  if (!context.flat) obj.push(`g proxy_${sanitizeObjName(leaf.instance?.label || leaf.dbId)}_${sanitizeObjName(leaf.dbId)}`);
  if (leaf.instance) obj.push(`# Instance: ${leaf.instance.label} ${leaf.instance.uuid || ""}`);
  obj.push(`# Proxy part: ${leaf.label}`);
  obj.push(`# Proxy reason: ${leaf.proxy.reason}`);
  obj.push(`usemtl ${materialName}`);
  for (const vertex of corners) obj.push(`v ${vertex[0]} ${vertex[1]} ${vertex[2]}`);
  for (const uv of uvs) obj.push(`vt ${uv[0]} ${uv[1]}`);
  for (const normal of normals) obj.push(`vn ${normal[0]} ${normal[1]} ${normal[2]}`);
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
    const vn = normalBase + faceIndex + 1;
    obj.push(`f ${faces[faceIndex].map((index, uvIndex) => `${vertexBase + index + 1}/${uvBase + uvIndex + 1}/${vn}`).join(" ")}`);
  }
  return { v: corners.length, vt: uvs.length, vn: normals.length };
}

function proxyMaterialForLeaf(leaf) {
  const label = `${leaf.label || ""} ${leaf.dbId || ""}`.toLowerCase();
  if (/(hob|oven|microwave|dishwasher|fridge|freezer|extractor|hood)/.test(label)) {
    return { name: "proxy_appliance_dark", color: [0.08, 0.08, 0.08] };
  }
  if (/(tap|mixer|stainless|plinth|rail|handle)/.test(label)) {
    return { name: "proxy_metal", color: [0.55, 0.55, 0.52] };
  }
  if (/(sink|havs?en|white|metod|maximera|utrusta|cabinet|frame|drawer|shelf)/.test(label)) {
    return { name: "proxy_cabinet_white", color: [0.92, 0.9, 0.86] };
  }
  if (/(chair|table|strandtorp|naesinge|näsinge|brown|wood|oak)/.test(label)) {
    return { name: "proxy_wood", color: [0.66, 0.49, 0.32] };
  }
  if (/(bin|lid|support frame|waste)/.test(label)) {
    return { name: "proxy_light_grey", color: [0.72, 0.72, 0.68] };
  }
  return { name: "proxy_neutral", color: [0.68, 0.68, 0.64] };
}

function normalForQuad(points) {
  const a = subtract3(points[1], points[0]);
  const b = subtract3(points[2], points[0]);
  return normalize(cross3(a, b));
}

function subtract3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

async function worktopMaterial(context, outDir) {
  const materialDbId = context.proceduralWorktops.find((slab) => slab.materialDbId)?.materialDbId;
  const asset = materialDbId ? context.assetById.get(materialDbId) : null;
  const fallback = { name: "procedural_worktop", color: [0.75, 0.72, 0.66], texture: null };
  if (!asset?.assetFile) return fallback;
  try {
    const zip = unzipSync(new Uint8Array(await fs.readFile(asset.assetFile)));
    const manifestBytes = zip["manifest.json"];
    const binary = zip["binary.bin"];
    if (!manifestBytes || !binary) return fallback;
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
    const material = manifest.materials?.[0] || {};
    const image = manifest.images?.[manifest.textures?.[material.diffuseMap || 0]?.image || 0];
    if (!image) return Object.assign(fallback, { color: material.color || fallback.color });
    const textureDir = path.join(outDir, "procedural_worktop_textures");
    await ensureDir(textureDir);
    const ext = image.format === "jpg" ? "jpg" : (image.format || "bin");
    const textureName = sanitizeFileName(`${materialDbId || "worktop"}.${ext}`);
    const texturePath = path.join(textureDir, textureName);
    await fs.writeFile(texturePath, Buffer.from(binary).slice(image.byteOffset, image.byteOffset + image.byteLength));
    return {
      name: "procedural_worktop",
      color: [1, 1, 1],
      texture: path.relative(outDir, texturePath).replace(/\\/g, "/"),
      sourceUvTransform: Array.isArray(material.uv0Transform) ? material.uv0Transform : null,
      sourceColor: material.color || null,
    };
  } catch {
    return fallback;
  }
}

function appendWorktopSlab(obj, slab, material, vertexBase, uvBase, normalBase, context) {
  const materialName = material.name;
  const bottomZ = slab.altitude;
  const topZ = slab.altitude + slab.thickness;
  const axes = slab.axes || axesFromOrientation(slab.orientation);
  const primary = slab.primary || extentOfPoints(slab.points, axes.u);
  const secondary = slab.secondary || extentOfPoints(slab.points, axes.v);
  const cutouts = clippedCutoutRects(slab.cutouts || [], primary, secondary);
  const xs = sortedUnique([primary.min, primary.max, ...cutouts.flatMap((rect) => [rect.minU, rect.maxU])]);
  const ys = sortedUnique([secondary.min, secondary.max, ...cutouts.flatMap((rect) => [rect.minV, rect.maxV])]);
  const counts = { v: 0, vt: 0, vn: 0 };

  obj.push("");
  if (!context.flat) obj.push(`g procedural_${sanitizeObjName(slab.label)}_${sanitizeObjName(slab.uuid)}`);
  obj.push(`# Procedural worktop: ${slab.uuid} ${slab.size.width.toFixed(1)}x${slab.size.depth.toFixed(1)}x${slab.size.thickness.toFixed(1)}mm`);
  if (cutouts.length) obj.push(`# Cutouts: ${cutouts.map((cutout) => `${cutout.kind}:${cutout.label}`).join("; ")}`);
  obj.push(`usemtl ${materialName}`);

  const point = (u, v, z) => {
    const xy = add2(mul2(axes.u, u), mul2(axes.v, v));
    return orientPoint([xy[0] * context.scale, xy[1] * context.scale, z * context.scale], context.axis);
  };
  const normal = (vector) => normalize(orientVector(vector, context.axis));
  const uv = (u, v) => worktopUv(u, v, primary, secondary, material, context.scale);
  const addQuad = (vertices, uvs, n) => {
    const vStart = vertexBase + counts.v + 1;
    const vtStart = uvBase + counts.vt + 1;
    const vnIndex = normalBase + counts.vn + 1;
    for (const vertex of vertices) obj.push(`v ${vertex[0]} ${vertex[1]} ${vertex[2]}`);
    for (const vt of uvs) obj.push(`vt ${vt[0]} ${vt[1]}`);
    obj.push(`vn ${n[0]} ${n[1]} ${n[2]}`);
    obj.push(`f ${[0, 1, 2].map((index) => `${vStart + index}/${vtStart + index}/${vnIndex}`).join(" ")}`);
    obj.push(`f ${[0, 2, 3].map((index) => `${vStart + index}/${vtStart + index}/${vnIndex}`).join(" ")}`);
    counts.v += 4;
    counts.vt += 4;
    counts.vn += 1;
  };

  for (let xi = 0; xi < xs.length - 1; xi++) {
    for (let yi = 0; yi < ys.length - 1; yi++) {
      const minU = xs[xi], maxU = xs[xi + 1], minV = ys[yi], maxV = ys[yi + 1];
      const centerU = (minU + maxU) / 2;
      const centerV = (minV + maxV) / 2;
      if (cutouts.some((rect) => rectContains(rect, centerU, centerV))) continue;
      addQuad(
        [point(minU, minV, topZ), point(maxU, minV, topZ), point(maxU, maxV, topZ), point(minU, maxV, topZ)],
        [uv(minU, minV), uv(maxU, minV), uv(maxU, maxV), uv(minU, maxV)],
        normal([0, 0, 1]),
      );
      addQuad(
        [point(minU, maxV, bottomZ), point(maxU, maxV, bottomZ), point(maxU, minV, bottomZ), point(minU, minV, bottomZ)],
        [uv(minU, maxV), uv(maxU, maxV), uv(maxU, minV), uv(minU, minV)],
        normal([0, 0, -1]),
      );
    }
  }

  addVerticalRect(addQuad, point, uv, normal, primary.min, primary.min, secondary.min, secondary.max, bottomZ, topZ, mul2(axes.u, -1));
  addVerticalRect(addQuad, point, uv, normal, primary.max, primary.max, secondary.max, secondary.min, bottomZ, topZ, axes.u);
  addVerticalRect(addQuad, point, uv, normal, primary.max, primary.min, secondary.min, secondary.min, bottomZ, topZ, mul2(axes.v, -1));
  addVerticalRect(addQuad, point, uv, normal, primary.min, primary.max, secondary.max, secondary.max, bottomZ, topZ, axes.v);

  for (const rect of cutouts) {
    addVerticalRect(addQuad, point, uv, normal, rect.minU, rect.minU, rect.maxV, rect.minV, bottomZ, topZ, axes.u);
    addVerticalRect(addQuad, point, uv, normal, rect.maxU, rect.maxU, rect.minV, rect.maxV, bottomZ, topZ, mul2(axes.u, -1));
    addVerticalRect(addQuad, point, uv, normal, rect.minU, rect.maxU, rect.minV, rect.minV, bottomZ, topZ, axes.v);
    addVerticalRect(addQuad, point, uv, normal, rect.maxU, rect.minU, rect.maxV, rect.maxV, bottomZ, topZ, mul2(axes.v, -1));
  }

  return counts;
}

function worktopUv(u, v, primary, secondary, material, scale) {
  void material;
  void scale;
  const width = Math.max(1, primary.max - primary.min);
  const depth = Math.max(1, secondary.max - secondary.min);
  return [(u - primary.min) / width, (v - secondary.min) / depth];
}

function addVerticalRect(addQuad, point, uv, normal, u1, u2, v1, v2, bottomZ, topZ, outward) {
  addQuad(
    [point(u1, v1, bottomZ), point(u1, v1, topZ), point(u2, v2, topZ), point(u2, v2, bottomZ)],
    [uv(u1, v1), uv(u1, v1), uv(u2, v2), uv(u2, v2)],
    normal([outward[0], outward[1], 0]),
  );
}

function clippedCutoutRects(cutouts, primary, secondary) {
  return cutouts
    .map((cutout) => Object.assign({}, cutout, {
      minU: Math.max(primary.min + 1, cutout.minU),
      maxU: Math.min(primary.max - 1, cutout.maxU),
      minV: Math.max(secondary.min + 1, cutout.minV),
      maxV: Math.min(secondary.max - 1, cutout.maxV),
    }))
    .filter((cutout) => cutout.maxU - cutout.minU >= 5 && cutout.maxV - cutout.minV >= 5);
}

function sortedUnique(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  for (const value of sorted) {
    if (!out.length || Math.abs(value - out[out.length - 1]) > 0.01) out.push(value);
  }
  return out;
}

function rectContains(rect, u, v) {
  return u > rect.minU && u < rect.maxU && v > rect.minV && v < rect.maxV;
}

function axesFromOrientation(orientation) {
  return canonicalAxes(orientation === "y" ? "y" : "x");
}

async function fitForLeaf(context, leaf, source) {
  const scalingAreas = await scalingAreasForAsset(context, leaf.assetFile);
  if (!scalingAreas) return null;
  const box = objBoundingBox(source);
  if (!box) return null;

  const axes = [
    { name: "x", index: 0, parameter: "width" },
    { name: "y", index: 1, parameter: "depth" },
    { name: "z", index: 2, parameter: "height" },
  ];
  const fit = {
    axes: {},
    transforms: new Map(),
    report: {
      scalingAreas,
      sourceSizeMeters: {
        x: round(box.max[0] - box.min[0]),
        y: round(box.max[1] - box.min[1]),
        z: round(box.max[2] - box.min[2]),
      },
      targetSizeMeters: {},
      axes: {},
    },
  };

  for (const axis of axes) {
    const areas = scalingAreas[axis.name];
    if (!areas?.length) continue;
    const sourceLength = box.max[axis.index] - box.min[axis.index];
    const targetValue = numericParameter(leaf.params?.[axis.parameter]);
    const targetLength = targetValue == null ? null : targetValue * context.scale;
    if (!Number.isFinite(targetLength) || targetLength <= 0 || sourceLength <= 0) continue;
    if (Math.abs(targetLength - sourceLength) < 0.0005) continue;

    const axisFit = createAxisFit(box.min[axis.index], box.max[axis.index], targetLength, areas);
    fit.transforms.set(axis.index, axisFit);
    fit.report.targetSizeMeters[axis.name] = round(targetLength);
    fit.report.axes[axis.name] = {
      parameter: axis.parameter,
      source: round(sourceLength),
      target: round(targetLength),
      anchor: axisFit.anchor,
      mode: axisFit.mode,
      scalableFraction: round(axisFit.scalableFraction),
      scale: round(axisFit.scale),
    };
  }

  return fit.transforms.size ? fit : null;
}

async function scalingAreasForAsset(context, assetFile) {
  if (!assetFile) return null;
  if (context.scalingAreasByAssetFile.has(assetFile)) return context.scalingAreasByAssetFile.get(assetFile);
  let scalingAreas = null;
  try {
    const zip = unzipSync(new Uint8Array(await fs.readFile(assetFile)));
    const manifestBytes = zip["manifest.json"];
    if (manifestBytes) {
      const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
      scalingAreas = mergeScalingAreas((manifest.nodes || []).map((node) => node.scalingAreas).filter(Boolean));
    }
  } catch {
    scalingAreas = null;
  }
  context.scalingAreasByAssetFile.set(assetFile, scalingAreas);
  return scalingAreas;
}

function mergeScalingAreas(items) {
  const merged = {};
  for (const item of items) {
    for (const axis of ["x", "y", "z"]) {
      if (!item?.[axis]?.length) continue;
      merged[axis] = (merged[axis] || []).concat(item[axis]);
    }
  }
  return Object.keys(merged).length ? merged : null;
}

function objBoundingBox(source) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith("v ")) continue;
    const point = line.split(/\s+/).slice(1, 4).map(Number);
    if (point.some((value) => !Number.isFinite(value))) continue;
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], point[i]);
      max[i] = Math.max(max[i], point[i]);
    }
    count++;
  }
  return count ? { min, max } : null;
}

function objStats(source) {
  const stats = { v: 0, vt: 0, vn: 0, f: 0 };
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith("v ")) stats.v++;
    else if (line.startsWith("vt ")) stats.vt++;
    else if (line.startsWith("vn ")) stats.vn++;
    else if (line.startsWith("f ")) stats.f++;
  }
  return stats;
}

function createAxisFit(min, max, targetLength, areas) {
  const sourceLength = max - min;
  let intervals = normalizedIntervals(areas).map((area) => ({
    start: area.start * sourceLength,
    end: area.end * sourceLength,
  }));
  const scalableLength = intervals.reduce((sum, area) => sum + Math.max(0, area.end - area.start), 0);
  const scalableTargetLength = scalableLength + targetLength - sourceLength;
  const uniformFallback = scalableLength <= 0 || scalableTargetLength <= 0;
  if (uniformFallback) intervals = [{ start: 0, end: sourceLength }];
  const scale = uniformFallback ? targetLength / sourceLength : scalableTargetLength / scalableLength;
  const segments = [];
  let cursor = 0;
  for (const area of intervals) {
    if (area.start > cursor) segments.push({ start: cursor, end: area.start, scale: 1 });
    if (area.end > area.start) segments.push({ start: area.start, end: area.end, scale });
    cursor = Math.max(cursor, area.end);
  }
  if (cursor < sourceLength) segments.push({ start: cursor, end: sourceLength, scale: 1 });

  let dst = 0;
  for (const segment of segments) {
    segment.dstStart = dst;
    dst += (segment.end - segment.start) * segment.scale;
    segment.dstEnd = dst;
  }

  const anchor = anchorMode(min, max);
  const offset = anchor === "center" ? -(targetLength - sourceLength) / 2 : (anchor === "max" ? -(targetLength - sourceLength) : 0);
  return {
    min,
    sourceLength,
    targetLength,
    anchor,
    mode: uniformFallback ? "uniform-fallback" : "scaling-areas",
    scale,
    scalableFraction: uniformFallback ? 1 : scalableLength / sourceLength,
    map(value) {
      const rel = value - min;
      const segment = segments.find((item) => rel <= item.end + 1e-9) || segments[segments.length - 1];
      return min + offset + segment.dstStart + (rel - segment.start) * segment.scale;
    },
  };
}

function normalizedIntervals(areas) {
  const intervals = areas
    .map((area) => ({
      start: Math.max(0, Math.min(1, Number(area.start))),
      end: Math.max(0, Math.min(1, Number(area.end))),
    }))
    .filter((area) => Number.isFinite(area.start) && Number.isFinite(area.end) && area.end > area.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const area of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && area.start <= previous.end) previous.end = Math.max(previous.end, area.end);
    else merged.push(area);
  }
  return merged;
}

function anchorMode(min, max) {
  const length = max - min;
  if (Math.abs(min + max) <= length * 0.03) return "center";
  if (Math.abs(min) <= length * 0.03) return "min";
  if (Math.abs(max) <= length * 0.03) return "max";
  return "center";
}

function fitPoint(point, fit) {
  const out = point.slice();
  for (const [index, axisFit] of fit.transforms) out[index] = Number(axisFit.map(point[index]).toPrecision(8));
  return out;
}

function numericParameter(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function round(value) {
  return Number(value.toPrecision(8));
}

async function materializeMtlTextures(mtlPath) {
  const outDir = path.dirname(mtlPath);
  const textureDir = path.join(outDir, `${path.basename(mtlPath, path.extname(mtlPath))}_textures`);
  let index = 0;
  let changed = false;
  const lines = (await fs.readFile(mtlPath, "utf8")).split(/\r?\n/);
  const rewritten = [];

  for (const line of lines) {
    if (!line.startsWith("map_Kd ")) {
      rewritten.push(line);
      continue;
    }
    const textureRef = line.slice(7).trim();
    const source = path.resolve(outDir, textureRef);
    if (!(await exists(source))) {
      rewritten.push(line);
      continue;
    }
    await ensureDir(textureDir);
    const targetName = uniqueTextureName(textureDir, `${index++}_${path.basename(source)}`);
    const target = path.join(textureDir, targetName);
    await fs.copyFile(source, target);
    rewritten.push(`map_Kd ${path.relative(outDir, target).replace(/\\/g, "/")}`);
    changed = true;
  }

  if (changed) await fs.writeFile(mtlPath, `${rewritten.join("\n")}\n`);
}

function uniqueTextureName(textureDir, name) {
  const parsed = path.parse(name);
  let candidate = name;
  let suffix = 2;
  while (require("node:fs").existsSync(path.join(textureDir, candidate))) {
    candidate = `${parsed.name}_${suffix++}${parsed.ext}`;
  }
  return candidate;
}

function transformExportedPoint(m, p, scale) {
  const x = p[0], y = p[1], z = p[2];
  return [
    Number((m[0] * x + m[4] * y + m[8] * z + m[12] * scale).toPrecision(8)),
    Number((m[1] * x + m[5] * y + m[9] * z + m[13] * scale).toPrecision(8)),
    Number((m[2] * x + m[6] * y + m[10] * z + m[14] * scale).toPrecision(8)),
  ];
}

function orientPoint(point, axis) {
  if (axis === "y-up") return [point[0], point[2], -point[1]];
  return point;
}

function orientVector(vector, axis) {
  if (axis === "y-up") return [vector[0], vector[2], -vector[1]];
  return vector;
}

function multiplyMatrices(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function transformVector(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ];
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [Number((v[0] / length).toPrecision(8)), Number((v[1] / length).toPrecision(8)), Number((v[2] / length).toPrecision(8))];
}

function normalizeVector(v, fallback = [0, 0, 0]) {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!length) return fallback.slice();
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function numeric(value) {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return 0;
}

function labelForAsset(asset) {
  return asset?.label || asset?.resource?.id || "";
}

function sanitizeObjName(name) {
  return String(name || "part").replace(/[^A-Za-z0-9_-]/g, "_");
}

async function exists(file) {
  return Boolean(await fs.stat(file).catch(() => null));
}

function visit(value, onValue, pointer = []) {
  onValue(value, pointer);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) value.forEach((item, index) => visit(item, onValue, pointer.concat(index)));
  else Object.entries(value).forEach(([key, item]) => visit(item, onValue, pointer.concat(key)));
}

module.exports = { assembleInputs };
