"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { triangulatePolygon } = require("./geometry");

async function writeWorktopObj(geometry, plan, source, options = {}) {
  if (!options.out) throw new Error("exportWorktopPlan requires options.out");
  const outDir = path.resolve(options.out);
  await fs.mkdir(outDir, { recursive: true });
  const basename = sanitizeFileName(options.name || `ikea-worktop-${plan.configurationId || source.reference?.code || "design"}`);
  const objPath = path.join(outDir, `${basename}.obj`);
  const mtlPath = path.join(outDir, `${basename}.mtl`);
  const reportPath = path.join(outDir, `${basename}.worktop-report.json`);
  const axis = options.axis || "y-up";
  if (!new Set(["y-up", "z-up"]).has(axis)) throw new Error(`Expected axis to be y-up or z-up; got ${axis}`);
  const scale = options.scale == null ? 0.001 : Number(options.scale);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("scale must be a positive number");

  const materialDefinitions = buildMaterials(geometry.segments);
  const obj = [
    "# IKEA Custom Worktop Calculator export",
    `mtllib ${path.basename(mtlPath)}`,
  ];
  let vertexBase = 1;
  let uvBase = 1;
  let normalBase = 1;
  let faceCount = 0;
  let vertexCount = 0;
  let uvCount = 0;
  let normalCount = 0;
  const outputBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const segmentReports = [];

  for (const segment of geometry.segments) {
    const result = appendSegment(obj, segment, {
      axis,
      scale,
      vertexBase,
      uvBase,
      normalBase,
      materialName: materialDefinitions.byKey.get(materialKey(segment)).name,
      outputBounds,
    });
    vertexBase += result.vertices;
    uvBase += result.uvs;
    normalBase += result.normals;
    vertexCount += result.vertices;
    uvCount += result.uvs;
    normalCount += result.normals;
    faceCount += result.faces;
    segmentReports.push({
      id: segment.id,
      target: segment.target,
      polygonMm: segment.polygonMm,
      thicknessMm: segment.thicknessMm,
      areaMm2: segment.areaMm2,
      volumeMm3: segment.volumeMm3,
      material: segment.material,
      expression: segment.expression,
      syntheticPlacement: segment.syntheticPlacement,
      vertices: result.vertices,
      faces: result.faces,
    });
  }

  const mtl = ["# IKEA Custom Worktop Calculator materials"];
  for (const material of materialDefinitions.materials) {
    mtl.push("", `newmtl ${material.name}`);
    mtl.push(`Ka ${numbers(material.color.map((value) => value * 0.2))}`);
    mtl.push(`Kd ${numbers(material.color)}`);
    mtl.push("Ks 0.06 0.06 0.06", "Ns 80", "d 1", "illum 2");
  }

  const report = {
    schemaVersion: 1,
    source: {
      configurationId: plan.configurationId || source.reference?.code || null,
      application: plan.application,
      applicationName: plan.applicationName,
      configurationVersion: plan.configurationVersion,
      country: source.reference?.country || null,
      language: source.reference?.language || null,
      locale: source.reference?.locale || null,
      configurationUrl: source.url || null,
      inputUrl: source.reference?.inputUrl || null,
    },
    outputs: {
      obj: objPath,
      mtl: mtlPath,
      report: reportPath,
      textures: [],
    },
    summary: {
      segments: geometry.segments.length,
      vertices: vertexCount,
      textureCoordinates: uvCount,
      normals: normalCount,
      faces: faceCount,
      configuredOperations: geometry.operations.configured.reduce((sum, operation) => sum + operation.count, 0),
      appliedOperations: 0,
      warnings: geometry.warnings.length,
    },
    export: {
      axis,
      scale,
      sourceUnit: "millimeter",
      outputUnit: scale === 0.001 ? "meter" : "scaled-millimeter",
      bounds: Number.isFinite(outputBounds.min[0]) ? outputBounds : null,
    },
    plan: {
      shape: plan.main.shape,
      measurementsMm: plan.measurements,
      flipped: plan.main.flipped,
      thicknessMm: plan.main.thicknessMm,
      island: plan.island,
      parameters: plan.parameters,
      items: plan.itemList,
    },
    segments: segmentReports,
    materials: materialDefinitions.materials.map((material) => ({
      ...material,
      texture: {
        status: "unavailable",
        reason: "The saved cwcalc configuration and its generic design image do not expose a seamless surface texture.",
      },
    })),
    operations: geometry.operations,
    warnings: geometry.warnings,
    limitations: [
      "Sink and cut-out selections contain no positions in the public saved configuration, so the OBJ has no invented holes.",
      "Kitchen islands and the two runs of an II-shape have dimensions but no relative room placement; exported spacing is synthetic and is marked per segment.",
      "The calculator exposes a generic design image, not a seamless material texture; the MTL uses an expression-derived approximate diffuse colour.",
    ],
  };

  await fs.writeFile(objPath, `${obj.join("\n")}\n`);
  await fs.writeFile(mtlPath, `${mtl.join("\n")}\n`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { objPath, mtlPath, reportPath, report, outputs: [objPath, mtlPath, reportPath] };
}

function appendSegment(lines, segment, state) {
  const points = segment.polygonMm;
  const triangles = triangulatePolygon(points);
  const n = points.length;
  const bounds = bounds2d(points);
  const width = Math.max(1, bounds.max[0] - bounds.min[0]);
  const depth = Math.max(1, bounds.max[1] - bounds.min[1]);
  const materialName = state.materialName;
  lines.push("", `o ${sanitizeObjName(segment.id)}`, `g ${sanitizeObjName(segment.target)}`, `usemtl ${materialName}`, "s off");

  for (const height of [0, segment.thicknessMm]) {
    for (const [x, y] of points) {
      const point = orientPoint([x * state.scale, y * state.scale, height * state.scale], state.axis);
      updateBounds(state.outputBounds, point);
      lines.push(`v ${numbers(point)}`);
    }
  }
  for (let layer = 0; layer < 2; layer++) {
    for (const [x, y] of points) lines.push(`vt ${number((x - bounds.min[0]) / width)} ${number(1 - (y - bounds.min[1]) / depth)}`);
  }

  const sideNormals = points.map((point, index) => {
    const next = points[(index + 1) % n];
    const dx = next[0] - point[0];
    const dy = next[1] - point[1];
    const length = Math.hypot(dx, dy) || 1;
    return [dy / length, -dx / length, 0];
  });
  const normals = [[0, 0, -1], [0, 0, 1], ...sideNormals].map((normal) => orientVector(normal, state.axis));
  for (const normal of normals) lines.push(`vn ${numbers(normal)}`);

  const token = (vertex, uv, normal) => `${state.vertexBase + vertex}/${state.uvBase + uv}/${state.normalBase + normal}`;
  let faces = 0;
  for (const [a, b, c] of triangles) {
    lines.push(`f ${token(n + a, n + a, 1)} ${token(n + b, n + b, 1)} ${token(n + c, n + c, 1)}`);
    lines.push(`f ${token(c, c, 0)} ${token(b, b, 0)} ${token(a, a, 0)}`);
    faces += 2;
  }
  for (let index = 0; index < n; index++) {
    const next = (index + 1) % n;
    const normal = 2 + index;
    lines.push(`f ${token(index, index, normal)} ${token(next, next, normal)} ${token(n + next, n + next, normal)}`);
    lines.push(`f ${token(index, index, normal)} ${token(n + next, n + next, normal)} ${token(n + index, n + index, normal)}`);
    faces += 2;
  }

  return { vertices: n * 2, uvs: n * 2, normals: n + 2, faces };
}

function buildMaterials(segments) {
  const byKey = new Map();
  for (const segment of segments) {
    const key = materialKey(segment);
    if (byKey.has(key)) continue;
    const name = sanitizeObjName(`worktop_${segment.target}_${segment.material || "material"}_${segment.expression || "expression"}`);
    byKey.set(key, {
      name,
      target: segment.target,
      material: segment.material,
      expression: segment.expression,
      color: expressionColor(segment.expression, segment.material),
      approximate: true,
    });
  }
  return { byKey, materials: [...byKey.values()] };
}

function materialKey(segment) {
  return `${segment.target}:${segment.material || ""}:${segment.expression || ""}`;
}

function expressionColor(expression, material) {
  const value = `${expression || ""} ${material || ""}`.toLowerCase();
  if (/black|charcoal/.test(value)) return [0.08, 0.08, 0.075];
  if (/dark.*grey|dark.*gray/.test(value)) return [0.22, 0.23, 0.23];
  if (/terracotta|rust/.test(value)) return [0.58, 0.28, 0.19];
  if (/oak|ash|walnut|wood|veneer|plywood/.test(value)) return [0.66, 0.5, 0.31];
  if (/aluminium|stainless|metal/.test(value)) return [0.55, 0.56, 0.56];
  if (/concrete|grey|gray|stone/.test(value)) return [0.47, 0.47, 0.45];
  if (/white|marble/.test(value)) return [0.9, 0.89, 0.84];
  return [0.62, 0.6, 0.55];
}

function orientPoint([x, y, z], axis) {
  return axis === "z-up" ? [x, y, z] : [x, z, -y];
}

function orientVector([x, y, z], axis) {
  return axis === "z-up" ? [x, y, z] : [x, z, -y];
}

function updateBounds(bounds, point) {
  for (let index = 0; index < 3; index++) {
    bounds.min[index] = Math.min(bounds.min[index], point[index]);
    bounds.max[index] = Math.max(bounds.max[index], point[index]);
  }
}

function bounds2d(points) {
  const bounds = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  for (const [x, y] of points) {
    bounds.min[0] = Math.min(bounds.min[0], x);
    bounds.min[1] = Math.min(bounds.min[1], y);
    bounds.max[0] = Math.max(bounds.max[0], x);
    bounds.max[1] = Math.max(bounds.max[1], y);
  }
  return bounds;
}

function sanitizeFileName(value) {
  const result = String(value).trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return result || "ikea-worktop";
}

function sanitizeObjName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]+/g, "_") || "worktop";
}

function number(value) {
  const rounded = Math.abs(value) < 1e-10 ? 0 : Number(value.toFixed(8));
  return String(rounded);
}

function numbers(values) {
  return values.map(number).join(" ");
}

module.exports = {
  expressionColor,
  writeWorktopObj,
};
