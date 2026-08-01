"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { ensureDir, sanitizeFileName } = require("./utils");
const { storageOneProfile } = require("./profile");
const {
  composeMatrix,
  decodeGlb,
  multiplyMatrices,
  transformDirection,
  transformPoint,
} = require("./glb");

async function exportPlatsaObj(bundle, options = {}) {
  return exportStorageOneObj(bundle, options, "platsa");
}

async function exportPaxObj(bundle, options = {}) {
  return exportStorageOneObj(bundle, options, "pax");
}

async function exportStorageOneObj(bundle, options = {}, planner = "platsa") {
  const profile = storageOneProfile(planner);
  const outDir = options.out;
  if (!outDir) throw new Error(`export${titleCase(profile.id)}Obj requires options.out`);
  await ensureDir(outDir);
  const basename = sanitizeFileName(options.name || `${profile.defaultNamePrefix}-${bundle.planId || "design"}`);
  const objPath = path.join(outDir, `${basename}.obj`);
  const mtlPath = path.join(outDir, `${basename}.mtl`);
  const textureDir = path.join(outDir, `${basename}_textures`);
  const decodedByKey = new Map();
  const materialNames = new Map();
  const texturePaths = new Map();
  const warnings = [];

  for (const instance of bundle.instances) {
    const asset = bundle.models.get(instance.productId);
    if (!asset || decodedByKey.has(asset.key)) continue;
    const decoded = await decodeGlb(asset.buffer);
    decodedByKey.set(asset.key, decoded);
    await materializeTextures(asset.key, decoded, textureDir, outDir, texturePaths, warnings);
  }

  const mtl = [`# ${profile.label} materials exported by ikea-planner-assets`];
  for (const [key, decoded] of decodedByKey) {
    for (const material of decoded.materials.length ? decoded.materials : [defaultMaterial()]) {
      const name = sanitizeObjName(`${key}_m${material.index}_${material.name}`);
      materialNames.set(`${key}:${material.index}`, name);
      const alpha = material.baseColor[3] == null ? 1 : material.baseColor[3];
      mtl.push("");
      mtl.push(`newmtl ${name}`);
      mtl.push(mtlDiffuseLine(material.baseColor));
      const specular = Math.max(0.04, Number(material.metallic) || 0);
      mtl.push(`Ks ${number(specular)} ${number(specular)} ${number(specular)}`);
      mtl.push(`Ns ${number(Math.max(1, (1 - material.roughness) * 1000))}`);
      mtl.push(`d ${number(alpha)}`);
      const texturePath = texturePaths.get(`${key}:${material.imageIndex}`);
      if (texturePath) mtl.push(`map_Kd ${path.relative(outDir, texturePath).replace(/\\/g, "/")}`);
    }
  }

  const obj = [
    `# ${profile.label} design exported by ikea-planner-assets`,
    `mtllib ${path.basename(mtlPath)}`,
  ];
  let vertexBase = 1;
  let uvBase = 1;
  let normalBase = 1;
  let faceCount = 0;
  let primitiveCount = 0;
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const instanceReports = [];

  for (const instance of bundle.instances) {
    const asset = bundle.models.get(instance.productId);
    const decoded = asset && decodedByKey.get(asset.key);
    if (!asset || !decoded) {
      warnings.push({ instanceId: instance.id, productId: instance.productId, reason: "missing-model" });
      continue;
    }
    const entityMatrix = matrixForInstance(instance);
    const catalogMatrix = matrixForCatalogTransform(instance.catalog?.modelTransform);
    const instanceMatrix = multiplyMatrices(entityMatrix, catalogMatrix);
    const instanceReport = {
      id: instance.id,
      icfId: instance.icfId || null,
      productId: instance.productId,
      label: instance.label,
      category: instance.category || null,
      source: instance.source,
      parentIds: instance.parentIds || [],
      childIds: instance.childIds || [],
      dimensionsMm: instance.dimensionsMm || null,
      transform: instance.transform,
      icfRotationDegrees: instance.icfRotationDegrees || null,
      catalogModelTransform: instance.catalog?.modelTransform || null,
      modelUrl: asset.url,
      primitives: 0,
      vertices: 0,
      faces: 0,
    };

    for (let primitiveIndex = 0; primitiveIndex < decoded.primitives.length; primitiveIndex++) {
      const primitive = decoded.primitives[primitiveIndex];
      if (primitive.mode !== 4) {
        warnings.push({ instanceId: instance.id, productId: instance.productId, reason: `unsupported-primitive-mode-${primitive.mode}` });
        continue;
      }
      const matrix = multiplyMatrices(instanceMatrix, primitive.matrix);
      const objectName = sanitizeObjName(`instance_${instance.id}_${instance.productId}_${primitiveIndex}`);
      obj.push("");
      obj.push(`o ${objectName}`);
      obj.push(`# ${instance.label || instance.productId}`);
      obj.push(`usemtl ${materialNames.get(`${asset.key}:${primitive.material}`) || materialNames.get(`${asset.key}:0`)}`);

      const vertexCount = primitive.positions.length / primitive.positionSize;
      const uvCount = primitive.uvs ? primitive.uvs.length / primitive.uvSize : 0;
      const normalCount = primitive.normals ? primitive.normals.length / primitive.normalSize : 0;
      for (let i = 0; i < vertexCount; i++) {
        const point = transformPoint(matrix, readVector(primitive.positions, i, primitive.positionSize));
        const oriented = orient(point, options.axis || "y-up");
        updateBounds(bounds, oriented);
        obj.push(`v ${number(oriented[0])} ${number(oriented[1])} ${number(oriented[2])}`);
      }
      for (let i = 0; i < uvCount; i++) {
        const offset = i * primitive.uvSize;
        obj.push(`vt ${number(primitive.uvs[offset])} ${number(1 - primitive.uvs[offset + 1])}`);
      }
      for (let i = 0; i < normalCount; i++) {
        const normal = orient(transformDirection(matrix, readVector(primitive.normals, i, primitive.normalSize)), options.axis || "y-up");
        obj.push(`vn ${number(normal[0])} ${number(normal[1])} ${number(normal[2])}`);
      }
      for (let i = 0; i + 2 < primitive.indices.length; i += 3) {
        const indices = [primitive.indices[i], primitive.indices[i + 1], primitive.indices[i + 2]];
        if (!indices.every((index) => index >= 0 && index < vertexCount)) continue;
        obj.push(`f ${indices.map((index) => faceToken(index, vertexBase, uvBase, normalBase, uvCount, normalCount)).join(" ")}`);
        faceCount++;
        instanceReport.faces++;
      }
      vertexBase += vertexCount;
      uvBase += uvCount;
      normalBase += normalCount;
      primitiveCount++;
      instanceReport.primitives++;
      instanceReport.vertices += vertexCount;
    }
    instanceReports.push(instanceReport);
  }

  await fs.writeFile(objPath, `${obj.join("\n")}\n`);
  await fs.writeFile(mtlPath, `${mtl.join("\n")}\n`);
  return {
    outputs: [objPath, mtlPath, ...texturePaths.values()],
    objPath,
    mtlPath,
    summary: {
      instances: instanceReports.length,
      primitives: primitiveCount,
      vertices: vertexBase - 1,
      textureCoordinates: uvBase - 1,
      normals: normalBase - 1,
      faces: faceCount,
      textures: texturePaths.size,
      warnings: warnings.length,
    },
    bounds: Number.isFinite(bounds.min[0]) ? bounds : null,
    instances: instanceReports,
    warnings,
  };
}

async function materializeTextures(key, decoded, textureDir, outDir, texturePaths, warnings) {
  for (const material of decoded.materials) {
    if (material.imageIndex == null) continue;
    const image = decoded.images[material.imageIndex];
    if (!image?.buffer) {
      warnings.push({ modelKey: key, material: material.name, reason: "texture-not-embedded", uri: image?.uri || null });
      continue;
    }
    const mapKey = `${key}:${material.imageIndex}`;
    if (texturePaths.has(mapKey)) continue;
    await ensureDir(textureDir);
    const extension = extensionForMimeType(image.mimeType);
    const target = path.join(textureDir, `${sanitizeFileName(key)}_${material.imageIndex}.${extension}`);
    await fs.writeFile(target, image.buffer);
    texturePaths.set(mapKey, target);
  }
}

function matrixForInstance(instance) {
  const transform = instance.transform || {};
  const position = transform.position || {};
  return composeMatrix({
    position: {
      x: (position.x || 0) * 0.001,
      y: (position.y || 0) * 0.001,
      z: (position.z || 0) * 0.001,
    },
    quaternion: transform.quaternion || null,
    rotationDegrees: transform.rotation || null,
    scale: transform.scale || { x: 1, y: 1, z: 1 },
  });
}

function matrixForCatalogTransform(transform) {
  const position = transform?.positionMm || {};
  return composeMatrix({
    position: {
      x: (position.x || 0) * 0.001,
      y: (position.y || 0) * 0.001,
      z: (position.z || 0) * 0.001,
    },
    rotationDegrees: transform?.rotationDegrees || null,
    scale: transform?.scale || { x: 1, y: 1, z: 1 },
  });
}

function faceToken(index, vertexBase, uvBase, normalBase, uvCount, normalCount) {
  const vertex = vertexBase + index;
  const uv = uvCount > index ? uvBase + index : "";
  const normal = normalCount > index ? normalBase + index : "";
  if (normal !== "") return `${vertex}/${uv}/${normal}`;
  if (uv !== "") return `${vertex}/${uv}`;
  return String(vertex);
}

function orient(vector, axis) {
  if (axis === "y-up") return vector;
  if (axis === "z-up") return [vector[0], -vector[2], vector[1]];
  throw new Error(`Expected axis to be y-up or z-up; got ${axis}`);
}

function readVector(values, index, size) {
  const offset = index * size;
  return [values[offset] || 0, values[offset + 1] || 0, values[offset + 2] || 0];
}

function updateBounds(bounds, point) {
  for (let axis = 0; axis < 3; axis++) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
}

function defaultMaterial() {
  return { index: 0, name: "default", baseColor: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.7, imageIndex: null };
}

function extensionForMimeType(mimeType) {
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/png") return "png";
  return "jpg";
}

function sanitizeObjName(value) {
  return String(value || "object").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function number(value) {
  const rounded = Math.abs(value) < 1e-12 ? 0 : value;
  return Number(Number(rounded).toPrecision(9));
}

function linearToSrgb(value) {
  const channel = Math.max(0, Math.min(1, Number(value) || 0));
  return channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

function mtlDiffuseLine(baseColor = []) {
  return `Kd ${[0, 1, 2].map((index) => number(linearToSrgb(baseColor[index]))).join(" ")}`;
}

function titleCase(value) {
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

module.exports = {
  exportPaxObj,
  exportPlatsaObj,
  exportStorageOneObj,
  linearToSrgb,
  matrixForCatalogTransform,
  matrixForInstance,
  mtlDiffuseLine,
};
