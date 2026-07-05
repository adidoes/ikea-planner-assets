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
    plinths: Boolean(options.plinths || options.worktops),
    proxyOverFaces: Number.isFinite(options.proxyOverFaces) ? options.proxyOverFaces : 0,
    internalPartsMode: internalPartsMode(options.internalParts),
    scale: Number.isFinite(options.scale) ? options.scale : 0.001,
    resourceById: collectResourceInfos(project),
    assetById: new Map((assetMap.assets || []).filter((asset) => asset.resource?.id).map((asset) => [asset.resource.id, asset])),
    furniture: collectFurniture(project),
    furnitureByUuid: new Map(),
    scalingAreasByAssetFile: new Map(),
    proceduralWorktops: [],
    proceduralPlinths: [],
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
    const rootLabel = furnitureLabel(context, root);
    const rootKey = root.dbId || root.uuid || rootLabel;
    await resolveProduct(context, {
      dbId: root.dbId,
      embeddedAssembly: root.embedResourceInfo?.assembly || null,
      params: Object.assign(
        {},
        paramsFromResource(root.resourceInfo),
        paramsFromConfig(root.parametersConfig),
        paramsFromConfig(root.contextConfig),
      ),
      matrix: rootMatrix(root, options.whole),
      label: rootLabel,
      instance: instanceSummary(context, root),
      trail: [rootKey],
      depth: 0,
    });
  }
  if (options.whole && context.worktops) {
    context.proceduralWorktops = collectProceduralWorktops(context);
    assignWorktopCutouts(context);
  }
  if (options.whole && context.plinths) {
    context.proceduralPlinths = collectProceduralPlinths(context);
  }

  const root = roots[0];
  const rootLabel = options.whole ? "Complete kitchen" : furnitureLabel(context, root);
  const rootKey = root.dbId || root.uuid || "assembly";
  const basename = options.whole
    ? sanitizeFileName(options.name || "Complete kitchen")
    : sanitizeFileName(`${rootLabel || rootKey}__${rootKey}_${root.uuid || "assembly"}`);
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
      proceduralPlinths: context.proceduralPlinths.length,
      operationCutouts: context.operationCutouts.length,
      internalLeaves: context.leaves.filter((leaf) => leaf.internalPart).length,
      omittedLeaves: context.leaves.filter((leaf) => leaf.omitted).length,
      proxyLeaves: context.leaves.filter((leaf) => leaf.proxy).length,
      skipped: context.skipped.length,
      maxDepth: Math.max(0, ...context.leaves.map((leaf) => leaf.depth)),
    },
    proceduralWorktops: context.proceduralWorktops,
    proceduralPlinths: context.proceduralPlinths,
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
  const stateKey = state.dbId || state.embeddedAssembly?.uuid || state.instance?.uuid || state.label;
  if (!stateKey || state.depth > 24) {
    if (stateKey) context.skipped.push({ dbId: state.dbId || null, key: stateKey, reason: "max-depth", trail: state.trail });
    return;
  }
  if (state.trail.slice(0, -1).includes(stateKey)) {
    context.skipped.push({ dbId: state.dbId || null, key: stateKey, reason: "cycle", trail: state.trail });
    return;
  }

  if (state.embeddedAssembly) {
    await resolveBmaComponents(context, state, state.embeddedAssembly, null, null);
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
  await resolveBmaComponents(context, state, bma, asset, resource, env);
}

async function resolveBmaComponents(context, state, bma, asset, resource, initialEnv) {
  const env = initialEnv || Object.assign({}, paramsFromBma(bma), paramsFromResource(resource?.resourceInfo), state.params);
  evaluateRelations(context, env, bma.relations || [], bma.components || []);
  if (asset) recordOperationCutout(context, state, asset, env);

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
      const text = await fs.readFile(mtlSource, "utf8").catch(() => null);
      if (text) {
        mtl.push(rewriteMtl(text, prefix, path.dirname(mtlSource), path.dirname(mtlPath)));
      } else {
        leaf.materialWarning = {
          reason: "missing-material-library",
          mtllib: lib,
          expectedMtl: mtlSource,
        };
        context.skipped.push({
          dbId: leaf.dbId || null,
          label: leaf.label || null,
          reason: "missing-material-library",
          mtllib: lib,
          expectedMtl: mtlSource,
          objPath: leaf.objPath,
          trail: leaf.trail,
        });
      }
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

  if (context.proceduralPlinths.length) {
    const material = await plinthMaterial(context, path.dirname(mtlPath));
    mtl.push("");
    mtl.push(`newmtl ${material.name}`);
    mtl.push(`Ka ${material.color.join(" ")}`);
    mtl.push(`Kd ${material.color.join(" ")}`);
    mtl.push("Ks 0.196078 0.196078 0.196078");
    mtl.push("illum 2");
    mtl.push("Ns 100");
    mtl.push("d 1");
    if (material.texture) mtl.push(`map_Kd ${material.texture}`);
    for (const segment of context.proceduralPlinths) {
      const counts = appendPlinthSegment(obj, segment, material, vertexBase, uvBase, normalBase, context);
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
        if (item?.dbId || item?.embedResourceInfo?.assembly) out.push(Object.assign({ path: pointer.concat(index).join("/") }, item));
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

function collectPlinthLinears(project) {
  const out = [];
  visit(project, (value) => {
    if (Array.isArray(value?.plinths)) out.push(...value.plinths);
  });
  const seen = new Set();
  return out.filter((plinth) => {
    if (!plinth?.uuid || seen.has(plinth.uuid)) return false;
    seen.add(plinth.uuid);
    return Array.isArray(plinth.furnitureIDs) && plinth.furnitureIDs.length;
  });
}

function collectLinearInstances(project, type) {
  const typeByUuid = new Map();
  visit(project, (value) => {
    const mapping = value?.furnitureLinearTypeMap;
    if (!mapping || typeof mapping !== "object") return;
    for (const [uuid, linearType] of Object.entries(mapping)) {
      typeByUuid.set(uuid, linearType);
    }
  });

  const out = [];
  const seen = new Set();
  visit(project, (value) => {
    if (!value?.uuid || seen.has(value.uuid)) return;
    if (typeByUuid.get(value.uuid) !== type) return;
    if (!value.embedResourceInfo?.designTree?.sketches) return;
    seen.add(value.uuid);
    out.push(value);
  });
  return out;
}

function collectProceduralWorktops(context) {
  const embedded = collectEmbeddedWorktopSlabs(context);
  if (embedded.length) return embedded;

  const slabs = [];
  for (const worktop of collectWorktopLinears(context.project)) {
    slabs.push(...slabsForWorktop(context, worktop));
  }
  normalizeWorktopOverlaps(slabs);
  alignWorktopCornerEdges(slabs);
  trimPerpendicularWorktopOverlaps(slabs);
  addWorktopCornerBridges(slabs);
  return slabs;
}

function collectEmbeddedWorktopSlabs(context) {
  const linears = collectLinearInstances(context.project, "Worktop");
  const worktops = collectWorktopLinears(context.project);
  const slabs = [];
  linears.forEach((linear, linearIndex) => {
    const worktop = worktops[linearIndex] || null;
    const materialDbId = dbIdFromValue(paramsFromConfig(linear.parametersConfig).Default) || worktop?.productInfoDbId || null;
    const thickness = Number(worktop?.thickness) || Number(worktop?.parameters?.height?.value) || 20;
    const altitude = embeddedWorktopAltitude(context, worktop, linear);
    const sketches = linear.embedResourceInfo?.designTree?.sketches || [];
    sketches.forEach((entry, sketchIndex) => {
      const sketch = entry.sketch || entry;
      const polygon = orderedSketchPolygon(sketch);
      if (polygon.length < 3) return;
      const rect = rectFromPoints(polygon);
      slabs.push({
        uuid: `${worktop?.uuid || linear.uuid}_board_${sketchIndex + 1}`,
        materialDbId,
        label: `Worktop ${linearIndex + 1}.${sketchIndex + 1}`,
        altitude,
        thickness,
        furnitureIDs: worktop?.furnitureIDs || [],
        sourceFurnitureIDs: worktop?.furnitureIDs || [],
        size: {
          width: rect.x.max - rect.x.min,
          depth: rect.y.max - rect.y.min,
          thickness,
        },
        axes: canonicalAxes("x"),
        primary: { min: rect.x.min, max: rect.x.max },
        secondary: { min: rect.y.min, max: rect.y.max },
        cutouts: [],
        points: polygon,
        polygon,
        embeddedWorktopSketch: true,
        embeddedFurnitureUuid: linear.uuid,
        sketchIndex,
      });
    });
  });
  return slabs;
}

function embeddedWorktopAltitude(context, worktop, linear) {
  const explicitAltitude = Number(worktop?.altitude);
  if (Number.isFinite(explicitAltitude)) return explicitAltitude;
  const linearZ = Number(linear?.transfo?.[14]);
  const base = Number.isFinite(linearZ) ? linearZ : 882;
  const furnitureTop = Math.max(
    ...((worktop?.furnitureIDs || [])
      .map((uuid) => context.furnitureByUuid.get(uuid))
      .map((item) => item ? bboxWorldMaxZ(item.boundingBox, item.transfo || identityMatrix()) : null)
      .filter(Number.isFinite)),
  );
  return Math.max(base, Number.isFinite(furnitureTop) ? furnitureTop : base);
}

function orderedSketchPolygon(sketch) {
  const edges = (sketch?.edges || [])
    .filter((edge) => edge.type === "EdgeLine" && edge.vertices?.length >= 2)
    .map((edge) => ({
      a: [Number(edge.vertices[0].x), Number(edge.vertices[0].y)],
      b: [Number(edge.vertices[1].x), Number(edge.vertices[1].y)],
    }))
    .filter((edge) => edge.a.every(Number.isFinite) && edge.b.every(Number.isFinite));
  if (!edges.length) return [];

  const unused = edges.slice();
  const first = unused.shift();
  const points = [first.a, first.b];
  const samePoint = (a, b) => distance2(a, b) <= 1;
  while (unused.length) {
    const tail = points[points.length - 1];
    const index = unused.findIndex((edge) => samePoint(edge.a, tail) || samePoint(edge.b, tail));
    if (index < 0) break;
    const [edge] = unused.splice(index, 1);
    points.push(samePoint(edge.a, tail) ? edge.b : edge.a);
    if (points.length > 3 && samePoint(points[0], points[points.length - 1])) break;
  }
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  return removeCollinearPoints(points);
}

function removeCollinearPoints(points) {
  if (points.length <= 3) return points;
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i + points.length - 1) % points.length];
    const curr = points[i];
    const next = points[(i + 1) % points.length];
    const a = [curr[0] - prev[0], curr[1] - prev[1]];
    const b = [next[0] - curr[0], next[1] - curr[1]];
    const cross = a[0] * b[1] - a[1] * b[0];
    if (Math.abs(cross) > 0.001) out.push(curr);
  }
  return out;
}

function rectFromPoints(points) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    x: { min: Math.min(...xs), max: Math.max(...xs) },
    y: { min: Math.min(...ys), max: Math.max(...ys) },
  };
}

function collectProceduralPlinths(context) {
  const plinths = collectPlinthLinears(context.project);
  const linears = collectLinearInstances(context.project, "Plinth");
  const segments = [];
  linears.forEach((linear, linearIndex) => {
    const plinth = plinths[linearIndex] || null;
    const materialDbId = dbIdFromValue(paramsFromConfig(linear.parametersConfig).Default) || plinth?.productInfoDbId || null;
    const height = Number(plinth?.parameters?.height?.value) || linearProfileHeight(linear) || 80;
    const thickness = Number(plinth?.parameters?.depth?.value) || linearProfileThickness(linear) || 10;
    linearPathEdges(linear).forEach((edge, segmentIndex) => {
      const a = edge.vertices?.[0];
      const b = edge.vertices?.[1];
      if (!a || !b) return;
      const start = [Number(a.x), Number(a.y)];
      const end = [Number(b.x), Number(b.y)];
      const length = distance2(start, end);
      if (!Number.isFinite(length) || length < 20) return;
      const topZ = Number(edge.plane?.O_z) || height;
      segments.push({
        uuid: `${linear.uuid}_${edge.gmID ?? segments.length}`,
        linearUuid: linear.uuid,
        plinthUuid: plinth?.uuid || null,
        materialDbId,
        label: `Plinth ${linearIndex + 1}.${segmentIndex + 1}`,
        furnitureIDs: plinth?.furnitureIDs || [],
        sourceFurnitureIDs: plinth?.furnitureIDs || [],
        height,
        thickness,
        altitude: topZ - height,
        topZ,
        length,
        start,
        end,
        productInfoDbId: plinth?.productInfoDbId || materialDbId,
      });
    });
  });
  return segments;
}

function linearPathEdges(linear) {
  const sketches = linear.embedResourceInfo?.designTree?.sketches || [];
  const pathSketch = sketches
    .map((entry) => entry.sketch || entry)
    .find((sketch) => (sketch.edges || []).some((edge) => edge.type === "EdgeLine" && edge.vertices?.[0]?.x !== undefined));
  if (!pathSketch) return [];
  return (pathSketch.edges || [])
    .filter((edge) => edge.type === "EdgeLine" && edge.vertices?.length >= 2)
    .map((edge) => Object.assign({ plane: pathSketch.plane || {} }, edge));
}

function linearProfileHeight(linear) {
  const profile = linearProfileBounds(linear);
  return profile ? profile.maxY - profile.minY : 0;
}

function linearProfileThickness(linear) {
  const profile = linearProfileBounds(linear);
  return profile ? profile.maxX - profile.minX : 0;
}

function linearProfileBounds(linear) {
  const sketches = linear.embedResourceInfo?.designTree?.sketches || [];
  const profileSketch = sketches
    .map((entry) => entry.sketch || entry)
    .find((sketch) => Number(sketch.plane?.O_z || 0) === 0);
  const points = (profileSketch?.edges || []).flatMap((edge) => edge.vertices || []);
  if (!points.length) return null;
  return {
    minX: Math.min(...points.map((point) => Number(point.x))),
    maxX: Math.max(...points.map((point) => Number(point.x))),
    minY: Math.min(...points.map((point) => Number(point.y))),
    maxY: Math.max(...points.map((point) => Number(point.y))),
  };
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

function alignWorktopCornerEdges(slabs) {
  for (let i = 0; i < slabs.length; i++) {
    for (let j = i + 1; j < slabs.length; j++) {
      alignWorktopCornerEdge(slabs[i], slabs[j]);
    }
  }
  for (const slab of slabs) refreshWorktopSlabGeometry(slab);
}

function alignWorktopCornerEdge(a, b) {
  if (a.orientation === b.orientation) return;
  if (Math.abs((a.altitude || 0) - (b.altitude || 0)) > 0.1) return;
  if (Math.abs((a.thickness || 0) - (b.thickness || 0)) > 0.1) return;
  if (a.materialDbId && b.materialDbId && a.materialDbId !== b.materialDbId) return;

  const rectA = worktopWorldRect(a);
  const rectB = worktopWorldRect(b);
  const overlapX = overlapRange(rectA.x, rectB.x);
  const overlapY = overlapRange(rectA.y, rectB.y);
  const touchesX = overlapX.size >= 100 || (rangeDistance(rectA.x, rectB.x) <= 5 && overlapY.size >= 100);
  const touchesY = overlapY.size >= 100 || (rangeDistance(rectA.y, rectB.y) <= 5 && overlapX.size >= 100);
  if (!touchesX && !touchesY) return;

  const maxOffset = 40;
  let changed = false;
  for (const axis of ["x", "y"]) {
    if (axis === "x" && !touchesY) continue;
    if (axis === "y" && !touchesX) continue;
    for (const side of ["min", "max"]) {
      const offset = Math.abs(rectA[axis][side] - rectB[axis][side]);
      if (offset <= 1 || offset > maxOffset) continue;
      const target = side === "min"
        ? Math.min(rectA[axis][side], rectB[axis][side])
        : Math.max(rectA[axis][side], rectB[axis][side]);
      if (setWorktopWorldEdge(a, axis, side, target)) changed = true;
      if (setWorktopWorldEdge(b, axis, side, target)) changed = true;
    }
  }
  if (changed) {
    a.cornerEdgeFixes = (a.cornerEdgeFixes || 0) + 1;
    b.cornerEdgeFixes = (b.cornerEdgeFixes || 0) + 1;
  }
}

function setWorktopWorldEdge(slab, axis, side, value) {
  if (!slab.primary || !slab.secondary || !Number.isFinite(value)) return false;
  const before = JSON.stringify([slab.primary, slab.secondary]);
  if (axis === "x" && slab.orientation === "x") {
    slab.primary[side] = value;
  } else if (axis === "x") {
    if (side === "min") slab.secondary.max = -value;
    else slab.secondary.min = -value;
  } else if (slab.orientation === "x") {
    slab.secondary[side] = value;
  } else {
    slab.primary[side] = value;
  }
  return before !== JSON.stringify([slab.primary, slab.secondary]);
}

function trimPerpendicularWorktopOverlaps(slabs) {
  const additions = [];
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 0; i < slabs.length; i++) {
      for (let j = i + 1; j < slabs.length; j++) {
        changed = trimPerpendicularWorktopOverlap(slabs[i], slabs[j], additions) || changed;
      }
    }
    if (!changed) break;
  }
  slabs.push(...additions);
  for (const slab of slabs) refreshWorktopSlabGeometry(slab);
}

function trimPerpendicularWorktopOverlap(a, b, additions) {
  if (a.orientation === b.orientation) return false;
  if (Math.abs((a.altitude || 0) - (b.altitude || 0)) > 0.1) return false;
  if (Math.abs((a.thickness || 0) - (b.thickness || 0)) > 0.1) return false;
  if (a.materialDbId && b.materialDbId && a.materialDbId !== b.materialDbId) return false;

  const rectA = worktopWorldRect(a);
  const rectB = worktopWorldRect(b);
  const overlapX = overlapRange(rectA.x, rectB.x);
  const overlapY = overlapRange(rectA.y, rectB.y);
  if (overlapX.size <= 1 || overlapY.size <= 1) return false;

  const axis = overlapY.size <= overlapX.size ? "y" : "x";
  const lower = rectA[axis].min <= rectB[axis].min
    ? { slab: a, rect: rectA, other: rectB }
    : { slab: b, rect: rectB, other: rectA };
  const target = lower.other[axis].min;
  if (target <= lower.rect[axis].min + 50 || target >= lower.rect[axis].max - 1) return false;

  const remainderRects = worktopOverlapRemainderRects(lower.rect, lower.other, axis, target);
  if (isFreestandingFillerWorktop(lower.slab)) {
    const shift = target - lower.rect[axis].max - freestandingFillerInset(lower.slab);
    const changed = translateWorktopWorld(lower.slab, axis, shift);
    if (changed) {
      lower.slab.freestandingFillerOffset = { axis, amount: shift };
      lower.slab.cornerOverlapFixes = (lower.slab.cornerOverlapFixes || 0) + 1;
    }
    return changed;
  }

  const changed = setWorktopWorldEdge(lower.slab, axis, "max", target);
  if (changed) {
    lower.slab.cornerOverlapFixes = (lower.slab.cornerOverlapFixes || 0) + 1;
    const remainders = remainderRects.map((rect) => worktopRemainderSlab(lower.slab, rect, additions.length + 1));
    additions.push(...remainders);
  }
  return changed;
}

function isFreestandingFillerWorktop(slab) {
  const text = [
    ...(slab.furnitureLabels || []),
    ...(slab.furnitureDbIds || []),
  ].join(" ").toLowerCase();
  return text.includes("freestanding filler") || text.includes("asm-42461142");
}

function freestandingFillerInset(slab) {
  const values = [];
  for (const params of slab.furnitureParams || []) {
    values.push(numericParameter(params.leftWidth));
    values.push(numericParameter(params.rightWidth));
  }
  const width = median(values.filter((value) => Number.isFinite(value) && value > 0));
  return (width || 75) / 2;
}

function translateWorktopWorld(slab, axis, delta) {
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.001) return false;
  refreshWorktopSlabGeometry(slab);
  const rect = worktopWorldRect(slab);
  const changedMin = setWorktopWorldEdge(slab, axis, "min", rect[axis].min + delta);
  const changedMax = setWorktopWorldEdge(slab, axis, "max", rect[axis].max + delta);
  refreshWorktopSlabGeometry(slab);
  return changedMin || changedMax;
}

function worktopOverlapRemainderRects(rect, other, axis, target) {
  const overlapX = overlapRange(rect.x, other.x);
  const overlapY = overlapRange(rect.y, other.y);
  const remainderAxis = axis === "y" ? "x" : "y";
  const overlap = remainderAxis === "x" ? overlapX : overlapY;
  const source = rect[remainderAxis];
  const sideRanges = [
    { min: source.min, max: overlap.min },
    { min: overlap.max, max: source.max },
  ].filter((range) => range.max - range.min > 5);
  const trimmedRange = { min: target, max: rect[axis].max };
  if (trimmedRange.max - trimmedRange.min <= 5) return [];
  return sideRanges.map((range) => axis === "y"
    ? { x: range, y: trimmedRange }
    : { x: trimmedRange, y: range });
}

function worktopRemainderSlab(source, rect, index) {
  const axes = canonicalAxes("x");
  return {
    uuid: `${source.uuid || "worktop"}__corner_overlap_remainder_${index}`,
    materialDbId: source.materialDbId || null,
    label: `${source.label || "Worktop"} corner remainder ${index}`,
    altitude: Number(source.altitude) || 882,
    thickness: Number(source.thickness) || 20,
    orientation: "x",
    furnitureIDs: source.furnitureIDs || [],
    furnitureDbIds: source.furnitureDbIds || [],
    furnitureLabels: source.furnitureLabels || [],
    sourceFurnitureIDs: source.sourceFurnitureIDs || source.furnitureIDs || [],
    size: {
      width: rect.x.max - rect.x.min,
      depth: rect.y.max - rect.y.min,
      thickness: Number(source.thickness) || 20,
    },
    axes,
    primary: { min: rect.x.min, max: rect.x.max },
    secondary: { min: rect.y.min, max: rect.y.max },
    cutouts: [],
    points: rectanglePoints(axes.u, axes.v, rect.x, rect.y),
    cornerOverlapRemainder: true,
    sourceSlab: source.label || source.uuid || null,
  };
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
  if (a.freestandingFillerOffset || b.freestandingFillerOffset) return null;
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

function rangeDistance(a, b) {
  const gap = gapRange(a, b);
  return gap ? gap.size : 0;
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
  const altitude = Math.max(
    Number(worktop.altitude) || 882,
    ...items.map((item) => item.topZ).filter(Number.isFinite),
  );

  for (const [key, oriented] of byOrientation) {
    const axes = canonicalAxes(key, oriented[0]);
    const clusters = clusterBySecondaryCenter(oriented, axes.v);
    const cluster = clusters.sort((a, b) => clusterScore(b, axes.u) - clusterScore(a, axes.u))[0];
    if (!cluster?.length) continue;

    const primaryItems = hasCorner && oriented.length > 1 && oriented.length === dominantCount ? items : cluster;
    const primary = extentAlong(primaryItems, axes.u);
    const depth = median(cluster.map((item) => item.depth)) || Number(worktop.parameters?.depth?.value) || 635;
    const targetDepth = depth + 35;
    const secondaryCenter = median(cluster.map((item) => dot2(item.center, axes.v)));
    const secondary = { min: secondaryCenter - targetDepth / 2, max: secondaryCenter + targetDepth / 2 };
    const applyEndOverhang = !hasCorner || oriented.length > 1;
    const startOverhang = applyEndOverhang ? Number(worktop.startOverhang) || 0 : 0;
    const endOverhang = applyEndOverhang ? Number(worktop.endOverhang) || 0 : 0;
    primary.min -= startOverhang;
    primary.max += endOverhang;

    slabs.push({
      uuid: worktop.uuid,
      materialDbId: worktop.productInfoDbId || null,
      label: `Worktop ${slabs.length + 1}`,
      altitude,
      thickness: Number(worktop.thickness) || 20,
      orientation: key,
      furnitureIDs: cluster.map((item) => item.uuid),
      furnitureDbIds: cluster.map((item) => item.dbId).filter(Boolean),
      furnitureLabels: cluster.map((item) => item.label).filter(Boolean),
      furnitureParams: cluster.map((item) => item.params).filter(Boolean),
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
  const corners = asymmetricFootprintCorners(item, matrix);
  const topZ = bboxWorldMaxZ(item.boundingBox, matrix);
  return { center, xAxis, yAxis, width, depth, corners, topZ };
}

function bboxSize(box, axis) {
  if (!box?.min || !box?.max) return 0;
  return Math.abs((box.max[axis] || 0) - (box.min[axis] || 0));
}

function bboxWorldMaxZ(box, matrix) {
  if (!box?.min || !box?.max) return null;
  const xs = [Number(box.min.x), Number(box.max.x)];
  const ys = [Number(box.min.y), Number(box.max.y)];
  const zs = [Number(box.min.z), Number(box.max.z)];
  if (![...xs, ...ys, ...zs].every(Number.isFinite)) return null;
  let maxZ = -Infinity;
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        maxZ = Math.max(maxZ, transformPointMm(matrix, [x, y, z])[2]);
      }
    }
  }
  return Number.isFinite(maxZ) ? maxZ : null;
}

function asymmetricFootprintCorners(item, matrix) {
  const box = item.boundingBox;
  if (!box?.min || !box?.max) return null;
  const minX = Number(box.min.x), maxX = Number(box.max.x);
  const minY = Number(box.min.y), maxY = Number(box.max.y);
  if (![minX, maxX, minY, maxY].every(Number.isFinite)) return null;
  const centerOffset = Math.hypot((minX + maxX) / 2, (minY + maxY) / 2);
  const params = paramsFromConfig(item.parametersConfig);
  const width = numericParameter(params.width);
  const depth = numericParameter(params.depth);
  const boxWidth = maxX - minX;
  const boxDepth = maxY - minY;
  const paramMismatch = (width && boxWidth > width * 2) || (depth && boxDepth > depth * 1.5);
  if (centerOffset < 50 && !paramMismatch) return null;
  return [
    transformPointMm(matrix, [minX, minY, 0]).slice(0, 2),
    transformPointMm(matrix, [maxX, minY, 0]).slice(0, 2),
    transformPointMm(matrix, [maxX, maxY, 0]).slice(0, 2),
    transformPointMm(matrix, [minX, maxY, 0]).slice(0, 2),
  ];
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
  if (Array.isArray(item.corners) && item.corners.length) return item.corners;
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

function distance2(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function normalize2(v, fallback = [0, 0]) {
  const length = Math.hypot(v[0], v[1]);
  if (!length) return fallback.slice();
  return [v[0] / length, v[1] / length];
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
  return {
    dbId: root.dbId || null,
    uuid: root.uuid || null,
    label: furnitureLabel(context, root),
    path: root.path || null,
  };
}

function placementSummary(context, root, whole) {
  return {
    dbId: root.dbId || null,
    uuid: root.uuid || null,
    label: furnitureLabel(context, root),
    path: root.path || null,
    matrix: rootMatrix(root, whole),
    localBoundingBox: root.boundingBox || null,
    worldBoundingBox: root.boundingBox ? transformBoundingBox(root.boundingBox, rootMatrix(root, whole)) : null,
  };
}

function furnitureLabel(context, root) {
  const asset = root.dbId ? context.assetById.get(root.dbId) : null;
  return labelForAsset(asset) ||
    root.productInfo?.definition?.name ||
    root.embedResourceInfo?.assembly?.name ||
    root.dbId ||
    root.uuid ||
    "embedded assembly";
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
    const rewrittenMap = rewriteMtlMapReference(line, sourceDir, outDir);
    if (rewrittenMap) return rewrittenMap;
    return line;
  }).join("\n");
}

function rewriteMtlMapReference(line, sourceDir, outDir) {
  const match = line.match(/^((?:map_\S+|bump|disp|decal|refl)\s+)(.+)$/);
  if (!match) return null;
  const texture = lastMtlToken(match[2]);
  if (!texture) return line;
  const beforeTexture = match[2].slice(0, match[2].length - texture.length);
  const abs = path.resolve(sourceDir, texture);
  const rewritten = path.relative(outDir, abs).replace(/\\/g, "/");
  return `${match[1]}${beforeTexture}${rewritten}`;
}

function lastMtlToken(value) {
  const tokens = String(value || "").trim().split(/\s+/).filter(Boolean);
  return tokens[tokens.length - 1] || "";
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
    const image = diffuseImageForMaterial(manifest, material);
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

async function plinthMaterial(context, outDir) {
  const materialDbId = context.proceduralPlinths.find((segment) => segment.materialDbId)?.materialDbId;
  const asset = materialDbId ? context.assetById.get(materialDbId) : null;
  const fallback = { name: "procedural_plinth", color: [0.71, 0.67, 0.6], texture: null };
  if (!asset?.assetFile) return fallback;
  try {
    const zip = unzipSync(new Uint8Array(await fs.readFile(asset.assetFile)));
    const manifestBytes = zip["manifest.json"];
    const binary = zip["binary.bin"];
    if (!manifestBytes) return fallback;
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
    const material = manifest.materials?.[0] || {};
    const image = binary ? diffuseImageForMaterial(manifest, material) : null;
    if (!image) return Object.assign(fallback, { color: material.color || fallback.color, sourceColor: material.color || null });
    const textureDir = path.join(outDir, "procedural_plinth_textures");
    await ensureDir(textureDir);
    const ext = image.format === "jpg" ? "jpg" : (image.format || "bin");
    const textureName = sanitizeFileName(`${materialDbId || "plinth"}.${ext}`);
    const texturePath = path.join(textureDir, textureName);
    await fs.writeFile(texturePath, Buffer.from(binary).slice(image.byteOffset, image.byteOffset + image.byteLength));
    return {
      name: "procedural_plinth",
      color: [1, 1, 1],
      texture: path.relative(outDir, texturePath).replace(/\\/g, "/"),
      sourceColor: material.color || null,
      sourceUvTransform: Array.isArray(material.uv0Transform) ? material.uv0Transform : null,
    };
  } catch {
    return fallback;
  }
}

function diffuseImageForMaterial(manifest, material) {
  if (material.diffuseMap == null) return null;
  const texture = manifest.textures?.[material.diffuseMap];
  if (!texture || texture.image == null) return null;
  return manifest.images?.[texture.image] || null;
}

function appendWorktopSlab(obj, slab, material, vertexBase, uvBase, normalBase, context) {
  if (slab.polygon?.length >= 3) {
    return appendPolygonWorktopSlab(obj, slab, material, vertexBase, uvBase, normalBase, context);
  }

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
  const sideUv = (u1, v1, u2, v2) => worktopSideUvs(u1, v1, u2, v2, bottomZ, topZ, context.scale);
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

  addVerticalRect(addQuad, point, sideUv, normal, primary.min, primary.min, secondary.min, secondary.max, bottomZ, topZ, mul2(axes.u, -1));
  addVerticalRect(addQuad, point, sideUv, normal, primary.max, primary.max, secondary.max, secondary.min, bottomZ, topZ, axes.u);
  addVerticalRect(addQuad, point, sideUv, normal, primary.max, primary.min, secondary.min, secondary.min, bottomZ, topZ, mul2(axes.v, -1));
  addVerticalRect(addQuad, point, sideUv, normal, primary.min, primary.max, secondary.max, secondary.max, bottomZ, topZ, axes.v);

  for (const rect of cutouts) {
    addVerticalRect(addQuad, point, sideUv, normal, rect.minU, rect.minU, rect.maxV, rect.minV, bottomZ, topZ, axes.u);
    addVerticalRect(addQuad, point, sideUv, normal, rect.maxU, rect.maxU, rect.minV, rect.maxV, bottomZ, topZ, mul2(axes.u, -1));
    addVerticalRect(addQuad, point, sideUv, normal, rect.minU, rect.maxU, rect.minV, rect.minV, bottomZ, topZ, axes.v);
    addVerticalRect(addQuad, point, sideUv, normal, rect.maxU, rect.minU, rect.maxV, rect.maxV, bottomZ, topZ, mul2(axes.v, -1));
  }

  return counts;
}

function appendPolygonWorktopSlab(obj, slab, material, vertexBase, uvBase, normalBase, context) {
  const materialName = material.name;
  const bottomZ = slab.altitude;
  const topZ = slab.altitude + slab.thickness;
  const polygon = slab.polygon || slab.points || [];
  const rect = rectFromPoints(polygon);
  const primary = slab.primary || { min: rect.x.min, max: rect.x.max };
  const secondary = slab.secondary || { min: rect.y.min, max: rect.y.max };
  const cutouts = clippedCutoutRects(slab.cutouts || [], primary, secondary);
  const xs = sortedUnique([
    ...polygon.map((point) => point[0]),
    ...cutouts.flatMap((cutout) => [cutout.minU, cutout.maxU]),
  ]);
  const ys = sortedUnique([
    ...polygon.map((point) => point[1]),
    ...cutouts.flatMap((cutout) => [cutout.minV, cutout.maxV]),
  ]);
  const counts = { v: 0, vt: 0, vn: 0 };

  obj.push("");
  if (!context.flat) obj.push(`g procedural_${sanitizeObjName(slab.label)}_${sanitizeObjName(slab.uuid)}`);
  obj.push(`# Procedural worktop: ${slab.uuid} ${slab.size.width.toFixed(1)}x${slab.size.depth.toFixed(1)}x${slab.size.thickness.toFixed(1)}mm`);
  obj.push("# Source: IKEA embedded worktop sketch");
  if (cutouts.length) obj.push(`# Cutouts: ${cutouts.map((cutout) => `${cutout.kind}:${cutout.label}`).join("; ")}`);
  obj.push(`usemtl ${materialName}`);

  const point = (u, v, z) => orientPoint([u * context.scale, v * context.scale, z * context.scale], context.axis);
  const uv = (u, v) => worktopUv(u, v, primary, secondary, material, context.scale);
  const sideUv = (u1, v1, u2, v2) => worktopSideUvs(u1, v1, u2, v2, bottomZ, topZ, context.scale);
  const addQuad = (vertices, uvs) => {
    const vStart = vertexBase + counts.v + 1;
    const vtStart = uvBase + counts.vt + 1;
    const vnIndex = normalBase + counts.vn + 1;
    for (const vertex of vertices) obj.push(`v ${vertex[0]} ${vertex[1]} ${vertex[2]}`);
    for (const vt of uvs) obj.push(`vt ${vt[0]} ${vt[1]}`);
    const n = normalForQuad(vertices);
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
      if (!pointInPolygon2([centerU, centerV], polygon)) continue;
      if (cutouts.some((cutout) => rectContains(cutout, centerU, centerV))) continue;
      addQuad(
        [point(minU, minV, topZ), point(maxU, minV, topZ), point(maxU, maxV, topZ), point(minU, maxV, topZ)],
        [uv(minU, minV), uv(maxU, minV), uv(maxU, maxV), uv(minU, maxV)],
      );
      addQuad(
        [point(minU, maxV, bottomZ), point(maxU, maxV, bottomZ), point(maxU, minV, bottomZ), point(minU, minV, bottomZ)],
        [uv(minU, maxV), uv(maxU, maxV), uv(maxU, minV), uv(minU, minV)],
      );
    }
  }

  const clockwise = polygonSignedArea(polygon) < 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (clockwise) {
      addPolygonVerticalRect(addQuad, point, sideUv, a[0], b[0], a[1], b[1], bottomZ, topZ);
    } else {
      addPolygonVerticalRect(addQuad, point, sideUv, b[0], a[0], b[1], a[1], bottomZ, topZ);
    }
  }

  for (const cutout of cutouts) {
    addPolygonVerticalRect(addQuad, point, sideUv, cutout.minU, cutout.minU, cutout.maxV, cutout.minV, bottomZ, topZ);
    addPolygonVerticalRect(addQuad, point, sideUv, cutout.maxU, cutout.maxU, cutout.minV, cutout.maxV, bottomZ, topZ);
    addPolygonVerticalRect(addQuad, point, sideUv, cutout.minU, cutout.maxU, cutout.minV, cutout.minV, bottomZ, topZ);
    addPolygonVerticalRect(addQuad, point, sideUv, cutout.maxU, cutout.minU, cutout.maxV, cutout.maxV, bottomZ, topZ);
  }

  return counts;
}

function addPolygonVerticalRect(addQuad, point, sideUv, u1, u2, v1, v2, bottomZ, topZ) {
  addQuad(
    [point(u1, v1, bottomZ), point(u1, v1, topZ), point(u2, v2, topZ), point(u2, v2, bottomZ)],
    sideUv(u1, v1, u2, v2),
  );
}

function appendPlinthSegment(obj, segment, material, vertexBase, uvBase, normalBase, context) {
  const length = distance2(segment.start, segment.end);
  const direction = normalize2([segment.end[0] - segment.start[0], segment.end[1] - segment.start[1]], [1, 0]);
  const normal2 = [-direction[1], direction[0]];
  const half = Math.max(1, segment.thickness || 10) / 2;
  const bottomZ = segment.altitude || 0;
  const topZ = segment.topZ || bottomZ + (segment.height || 80);
  const a0 = add2(segment.start, mul2(normal2, -half));
  const a1 = add2(segment.start, mul2(normal2, half));
  const b0 = add2(segment.end, mul2(normal2, -half));
  const b1 = add2(segment.end, mul2(normal2, half));
  const counts = { v: 0, vt: 0, vn: 0 };

  obj.push("");
  if (!context.flat) obj.push(`g procedural_${sanitizeObjName(segment.label)}_${sanitizeObjName(segment.uuid)}`);
  obj.push(`# Procedural plinth: ${segment.uuid} ${length.toFixed(1)}x${segment.thickness.toFixed(1)}x${segment.height.toFixed(1)}mm`);
  obj.push(`usemtl ${material.name}`);

  const point = (xy, z) => orientPoint([xy[0] * context.scale, xy[1] * context.scale, z * context.scale], context.axis);
  const addQuad = (vertices, uvs) => {
    const oriented = vertices.map((vertex) => point(vertex.xy, vertex.z));
    const vStart = vertexBase + counts.v + 1;
    const vtStart = uvBase + counts.vt + 1;
    const vnIndex = normalBase + counts.vn + 1;
    for (const vertex of oriented) obj.push(`v ${vertex[0]} ${vertex[1]} ${vertex[2]}`);
    for (const uv of uvs) obj.push(`vt ${uv[0]} ${uv[1]}`);
    const n = normalForQuad(oriented);
    obj.push(`vn ${n[0]} ${n[1]} ${n[2]}`);
    obj.push(`f ${[0, 1, 2].map((index) => `${vStart + index}/${vtStart + index}/${vnIndex}`).join(" ")}`);
    obj.push(`f ${[0, 2, 3].map((index) => `${vStart + index}/${vtStart + index}/${vnIndex}`).join(" ")}`);
    counts.v += 4;
    counts.vt += 4;
    counts.vn += 1;
  };
  const uvLen = length / 1000;
  const uvHeight = Math.max(1, segment.height || 80) / 1000;

  addQuad(
    [{ xy: a0, z: bottomZ }, { xy: b0, z: bottomZ }, { xy: b0, z: topZ }, { xy: a0, z: topZ }],
    [[0, 0], [uvLen, 0], [uvLen, uvHeight], [0, uvHeight]],
  );
  addQuad(
    [{ xy: b1, z: bottomZ }, { xy: a1, z: bottomZ }, { xy: a1, z: topZ }, { xy: b1, z: topZ }],
    [[0, 0], [uvLen, 0], [uvLen, uvHeight], [0, uvHeight]],
  );
  addQuad(
    [{ xy: a1, z: topZ }, { xy: a0, z: topZ }, { xy: b0, z: topZ }, { xy: b1, z: topZ }],
    [[0, 0], [0, 1], [uvLen, 1], [uvLen, 0]],
  );
  addQuad(
    [{ xy: a0, z: bottomZ }, { xy: a1, z: bottomZ }, { xy: b1, z: bottomZ }, { xy: b0, z: bottomZ }],
    [[0, 0], [0, 1], [uvLen, 1], [uvLen, 0]],
  );
  addQuad(
    [{ xy: a1, z: bottomZ }, { xy: a0, z: bottomZ }, { xy: a0, z: topZ }, { xy: a1, z: topZ }],
    [[0, 0], [1, 0], [1, uvHeight], [0, uvHeight]],
  );
  addQuad(
    [{ xy: b0, z: bottomZ }, { xy: b1, z: bottomZ }, { xy: b1, z: topZ }, { xy: b0, z: topZ }],
    [[0, 0], [1, 0], [1, uvHeight], [0, uvHeight]],
  );

  return counts;
}

function worktopUv(u, v, primary, secondary, material, scale) {
  const width = Math.max(1, primary.max - primary.min);
  const depth = Math.max(1, secondary.max - secondary.min);
  if (!material?.texture) return [(u - primary.min) / width, (v - secondary.min) / depth];
  if (Array.isArray(material.sourceUvTransform)) return applyUvTransform([u, v], material.sourceUvTransform);
  const unitScale = Number.isFinite(scale) ? scale : 0.001;
  return [(u - primary.min) * unitScale, (v - secondary.min) * unitScale];
}

function worktopSideUvs(u1, v1, u2, v2, bottomZ, topZ, scale) {
  const unitScale = Number.isFinite(scale) ? scale : 0.001;
  const length = Math.max(0.001, Math.hypot(u2 - u1, v2 - v1) * unitScale);
  const height = Math.max(0.001, Math.abs(topZ - bottomZ) * unitScale);
  return [[0, 0], [0, height], [length, height], [length, 0]];
}

function applyUvTransform(uv, transform) {
  if (!Array.isArray(transform)) return uv;
  const nums = transform.map(Number);
  if (nums.length >= 9 && nums.slice(0, 6).every(Number.isFinite)) {
    return [
      nums[0] * uv[0] + nums[3] * uv[1] + nums[6],
      nums[1] * uv[0] + nums[4] * uv[1] + nums[7],
    ];
  }
  if (nums.length >= 6 && nums.slice(0, 6).every(Number.isFinite)) {
    return [
      nums[0] * uv[0] + nums[2] * uv[1] + nums[4],
      nums[1] * uv[0] + nums[3] * uv[1] + nums[5],
    ];
  }
  if (nums.length >= 4 && nums.slice(0, 4).every(Number.isFinite)) {
    return [nums[0] * uv[0] + nums[2], nums[1] * uv[1] + nums[3]];
  }
  return uv;
}

function addVerticalRect(addQuad, point, sideUv, normal, u1, u2, v1, v2, bottomZ, topZ, outward) {
  addQuad(
    [point(u1, v1, bottomZ), point(u1, v1, topZ), point(u2, v2, topZ), point(u2, v2, bottomZ)],
    sideUv(u1, v1, u2, v2),
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

function pointInPolygon2(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersects = ((yi > point[1]) !== (yj > point[1])) &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonSignedArea(polygon) {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
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
    if (!isMtlTextureMapLine(line)) {
      rewritten.push(line);
      continue;
    }
    const textureRef = lastMtlToken(line.replace(/^(?:map_\S+|bump|disp|decal|refl)\s+/, ""));
    const source = path.resolve(outDir, textureRef);
    if (!(await exists(source))) {
      rewritten.push(line);
      continue;
    }
    await ensureDir(textureDir);
    const targetName = uniqueTextureName(textureDir, `${index++}_${path.basename(source)}`);
    const target = path.join(textureDir, targetName);
    await fs.copyFile(source, target);
    rewritten.push(line.slice(0, line.length - textureRef.length) + path.relative(outDir, target).replace(/\\/g, "/"));
    changed = true;
  }

  if (changed) await fs.writeFile(mtlPath, `${rewritten.join("\n")}\n`);
}

function isMtlTextureMapLine(line) {
  return /^(?:map_\S+|bump|disp|decal|refl)\s+/.test(line);
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
