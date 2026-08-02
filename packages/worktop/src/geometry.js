"use strict";

const STANDARD_DEPTH_MM = 635;
const V_CORNER_MM = 1066;
const C_OUTER_DIAGONAL_OFFSET_MM = 803;

function buildWorktopGeometry(plan, options = {}) {
  const separateGapMm = finiteNonNegative(options.separateGapMm == null ? 500 : options.separateGapMm, "separateGapMm");
  const mainFootprints = footprintsForShape(plan.main.shape, plan.measurements, {
    flipped: plan.main.flipped,
    separateGapMm,
  });
  const segments = mainFootprints.map((footprint, index) => makeSegment({
    id: `main-${index + 1}`,
    target: "main",
    footprint,
    thicknessMm: plan.main.thicknessMm,
    material: plan.main.material,
    expression: plan.main.expression,
  }));
  const warnings = [];

  if (mainFootprints.some((footprint) => footprint.syntheticPlacement)) {
    warnings.push({
      code: "relative-placement-unavailable",
      target: "main",
      message: "The II-shape stores both run dimensions but not the gap between them; separateGapMm was used.",
    });
  }

  if (plan.island && options.includeIsland !== false) {
    const bounds = bounds2d(segments.flatMap((segment) => segment.polygonMm));
    const islandFootprint = footprintsForShape("rectangular", plan.island.measurements, { flipped: false, separateGapMm })[0];
    const translated = {
      ...islandFootprint,
      points: islandFootprint.points.map(([x, y]) => [x + bounds.max[0] + separateGapMm, y]),
      syntheticPlacement: true,
    };
    segments.push(makeSegment({
      id: "island-1",
      target: "island",
      footprint: translated,
      thicknessMm: plan.island.thicknessMm,
      material: plan.island.material,
      expression: plan.island.expression,
    }));
    warnings.push({
      code: "island-placement-unavailable",
      target: "island",
      message: "The saved calculator payload stores island dimensions but no room position; the island was laid out beside the main worktop.",
    });
  } else if (plan.island) {
    warnings.push({ code: "island-omitted", target: "island", message: "The configured kitchen island was omitted by options.includeIsland=false." });
  }

  const featureWarnings = unsupportedFeatureWarnings(plan.parameters);
  warnings.push(...featureWarnings);
  const unresolvedOperations = plan.operations.map((operation) => ({
    ...operation,
    reason: "The public saved payload records a quantity/selection but no cut position; no geometry was removed.",
  }));

  return {
    segments,
    boundsMm: segmentBounds(segments),
    warnings,
    operations: {
      configured: plan.operations,
      applied: [],
      unresolved: unresolvedOperations,
    },
  };
}

function footprintsForShape(shape, dimensions, options = {}) {
  const d = dimensions;
  let footprints;
  switch (shape) {
    case "rectangular":
    case "kitchen-island":
      requireDimensions(shape, d, ["a", "b"]);
      footprints = [{ points: rectangle(0, 0, d.a, d.b) }];
      break;
    case "l-shape":
      requireDimensions(shape, d, ["a", "b", "c", "d"]);
      if (d.a <= d.d || d.b <= d.c) invalidCombination(shape);
      footprints = [{ points: [[0, 0], [d.a, 0], [d.a, d.c], [d.d, d.c], [d.d, d.b], [0, d.b]] }];
      break;
    case "u-shape":
      requireDimensions(shape, d, ["a", "b", "c", "d", "e", "f"]);
      if (d.a <= d.e + d.f || d.b <= d.d || d.c <= d.d) invalidCombination(shape);
      footprints = [{ points: [[0, 0], [d.a, 0], [d.a, d.c], [d.a - d.f, d.c], [d.a - d.f, d.d], [d.e, d.d], [d.e, d.b], [0, d.b]] }];
      break;
    case "v-shape": {
      requireDimensions(shape, d, ["a", "b"]);
      const c = d.c || STANDARD_DEPTH_MM;
      const depth = d.d || STANDARD_DEPTH_MM;
      if (d.a < V_CORNER_MM || d.b < V_CORNER_MM) invalidCombination(shape);
      footprints = [{ points: [[0, 0], [d.a, 0], [d.a, c], [V_CORNER_MM, c], [depth, V_CORNER_MM], [depth, d.b], [0, d.b]] }];
      break;
    }
    case "c-shape": {
      requireDimensions(shape, d, ["a", "b"]);
      const c = d.c || STANDARD_DEPTH_MM;
      const depth = d.d || STANDARD_DEPTH_MM;
      if (d.a <= 263 || d.b <= 263) invalidCombination(shape);
      footprints = [{ points: [
        [C_OUTER_DIAGONAL_OFFSET_MM, 0],
        [C_OUTER_DIAGONAL_OFFSET_MM + d.a, 0],
        [C_OUTER_DIAGONAL_OFFSET_MM + d.a, c],
        [V_CORNER_MM, c],
        [depth, V_CORNER_MM],
        [depth, C_OUTER_DIAGONAL_OFFSET_MM + d.b],
        [0, C_OUTER_DIAGONAL_OFFSET_MM + d.b],
        [0, C_OUTER_DIAGONAL_OFFSET_MM],
      ] }];
      break;
    }
    case "ii-shape":
      requireDimensions(shape, d, ["a", "b", "c", "d"]);
      footprints = [
        { points: rectangle(0, 0, d.a, d.b), syntheticPlacement: true },
        { points: rectangle(0, d.b + options.separateGapMm, d.c, d.d), syntheticPlacement: true },
      ];
      break;
    case "irregular":
      requireDimensions(shape, d, ["a", "b", "c"]);
      footprints = [{ points: [[0, 0], [d.a, 0], [d.a, d.c], [0, d.b]] }];
      break;
    case "g-shape":
      requireDimensions(shape, d, ["a", "b", "c", "d", "e", "f", "g", "h"]);
      if (d.a <= d.f + d.h || d.b <= d.e + d.g || d.c <= d.e || d.d <= d.f) invalidCombination(shape);
      footprints = [{ points: [
        [0, 0], [d.a, 0], [d.a, d.c], [d.a - d.h, d.c],
        [d.a - d.h, d.e], [d.f, d.e], [d.f, d.b - d.g],
        [d.d, d.b - d.g], [d.d, d.b], [0, d.b],
      ] }];
      break;
    default:
      throw new Error(`Unsupported Custom Worktop Calculator shape: ${shape}`);
  }

  return footprints.map((footprint) => {
    let points = normalizePolygon(footprint.points);
    if (options.flipped) points = flipPolygon(points);
    return { ...footprint, points };
  });
}

function makeSegment({ id, target, footprint, thicknessMm, material, expression }) {
  const areaMm2 = Math.abs(polygonArea(footprint.points));
  return {
    id,
    target,
    polygonMm: footprint.points,
    thicknessMm,
    areaMm2,
    volumeMm3: areaMm2 * thicknessMm,
    material,
    expression,
    syntheticPlacement: !!footprint.syntheticPlacement,
  };
}

function unsupportedFeatureWarnings(parameters) {
  const warnings = [];
  const overhang = parameters.overhang || parameters.overhangType;
  if (overhang && !["none", "no-overhang", "false"].includes(String(overhang))) {
    warnings.push({ code: "overhang-not-applied", value: overhang, message: "Overhang/waterfall selections are priced by cwcalc but their complete contour is not stored in the public payload." });
  }
  if (parameters.splashback && parameters.splashback !== "none") {
    warnings.push({ code: "splashback-not-exported", value: parameters.splashback, message: "This package exports worktop slabs; configured wall panels/splashbacks are reported but not modeled." });
  }
  if (parameters.wallEdgingStripCustomizable && parameters.wallEdgingStripCustomizable !== "none") {
    warnings.push({ code: "wall-edging-strip-not-exported", value: parameters.wallEdgingStripCustomizable, message: "Configured wall edging strips are not part of the exported worktop slab." });
  }
  return warnings;
}

function triangulatePolygon(points) {
  const polygon = normalizePolygon(points);
  const remaining = polygon.map((_, index) => index);
  const triangles = [];
  let guard = polygon.length * polygon.length;
  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let position = 0; position < remaining.length; position++) {
      const previous = remaining[(position - 1 + remaining.length) % remaining.length];
      const current = remaining[position];
      const next = remaining[(position + 1) % remaining.length];
      if (cross2(polygon[previous], polygon[current], polygon[next]) <= 1e-9) continue;
      if (remaining.some((candidate) => candidate !== previous && candidate !== current && candidate !== next
        && pointInTriangle(polygon[candidate], polygon[previous], polygon[current], polygon[next]))) continue;
      triangles.push([previous, current, next]);
      remaining.splice(position, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error("Could not triangulate worktop footprint");
  }
  if (remaining.length === 3) triangles.push([...remaining]);
  return triangles;
}

function normalizePolygon(points) {
  const normalized = points.map(([x, y]) => [Number(x), Number(y)]);
  if (normalized.length < 3 || normalized.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
    throw new Error("Worktop footprint must contain at least three finite points");
  }
  if (polygonArea(normalized) < 0) normalized.reverse();
  if (Math.abs(polygonArea(normalized)) < 1e-6) throw new Error("Worktop footprint has zero area");
  return normalized;
}

function flipPolygon(points) {
  const bounds = bounds2d(points);
  return normalizePolygon(points.map(([x, y]) => [bounds.min[0] + bounds.max[0] - x, y]));
}

function rectangle(x, y, width, depth) {
  return [[x, y], [x + width, y], [x + width, y + depth], [x, y + depth]];
}

function requireDimensions(shape, dimensions, keys) {
  for (const key of keys) {
    if (!Number.isFinite(dimensions[key]) || dimensions[key] <= 0) throw new Error(`${shape} requires positive measurement ${key}`);
  }
}

function invalidCombination(shape) {
  throw new Error(`Invalid measurement combination for ${shape}`);
}

function finiteNonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  return number;
}

function polygonArea(points) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

function cross2(a, b, c) {
  return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
}

function pointInTriangle(p, a, b, c) {
  const ab = cross2(a, b, p);
  const bc = cross2(b, c, p);
  const ca = cross2(c, a, p);
  return ab >= -1e-9 && bc >= -1e-9 && ca >= -1e-9;
}

function bounds2d(points) {
  const bounds = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  for (const point of points) {
    bounds.min[0] = Math.min(bounds.min[0], point[0]);
    bounds.min[1] = Math.min(bounds.min[1], point[1]);
    bounds.max[0] = Math.max(bounds.max[0], point[0]);
    bounds.max[1] = Math.max(bounds.max[1], point[1]);
  }
  return bounds;
}

function segmentBounds(segments) {
  if (!segments.length) return null;
  const planar = bounds2d(segments.flatMap((segment) => segment.polygonMm));
  return {
    min: [planar.min[0], planar.min[1], 0],
    max: [planar.max[0], planar.max[1], Math.max(...segments.map((segment) => segment.thicknessMm))],
  };
}

module.exports = {
  buildWorktopGeometry,
  footprintsForShape,
  polygonArea,
  triangulatePolygon,
};
