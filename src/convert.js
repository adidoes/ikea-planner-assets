"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { unzipSync } = require("fflate");
const { NodeIO } = require("@gltf-transform/core");
const { dedup, prune } = require("@gltf-transform/functions");
const { ensureDir, listFiles, writeJson } = require("./common");
const { signatureOf } = require("./inspect");

async function convertInputs(inputs, options) {
  await ensureDir(options.out);
  const files = await listFiles(inputs);
  const results = [];
  for (const file of files) {
    if (path.basename(file) === "analysis.json") continue;
    results.push(await convertOne(file, options));
  }

  const summary = {
    total: results.length,
    exported: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => !r.ok).length,
    byReason: results.filter((r) => !r.ok).reduce((acc, r) => {
      acc[r.reason] = (acc[r.reason] || 0) + 1;
      return acc;
    }, {}),
  };
  const outPath = path.join(options.out, "conversion-report.json");
  await writeJson(outPath, {
    schema: "ikea-planner-assets.conversion.v1",
    generatedAt: new Date().toISOString(),
    targetFormat: options.format,
    summary,
    files: results,
  });
  console.log(`Exported ${summary.exported}/${summary.total} supported assets; wrote ${outPath}`);
  if (summary.skipped) console.log(JSON.stringify(summary.byReason, null, 2));
}

async function convertOne(file, options) {
  const lower = file.toLowerCase();
  const buffer = await fs.readFile(file);
  const sig = signatureOf(buffer);
  if (isBm3Like(file, buffer)) {
    return convertBm3ToGlb(file, buffer, options);
  }
  if (sig === "glb" || lower.endsWith(".gltf")) {
    return normalizeGltf(file, options);
  }
  if (lower.endsWith(".obj") || sig === "obj") {
    return copyAsExport(file, options, "OBJ import source; keep as Live Home 3D fallback");
  }
  if (lower.endsWith(".dae")) {
    return copyAsExport(file, options, "DAE import source; keep as Live Home 3D fallback");
  }
  if (lower.endsWith(".geom") || lower.endsWith(".mesh")) {
    return {
      path: file,
      ok: false,
      reason: "proprietary-geometry",
      note: "Captured .geom/.mesh needs a format decoder before GLB export. Run inspect and compare decoded metadata with bundle loaders.",
    };
  }
  if (lower.endsWith(".texture") || lower.endsWith(".basis") || lower.endsWith(".ktx2")) {
    return {
      path: file,
      ok: false,
      reason: "texture-only",
      note: "Texture payloads are dependencies for model export; they are not standalone Live Home 3D objects.",
    };
  }
  return { path: file, ok: false, reason: "unsupported" };
}

function isBm3Like(file, buffer) {
  return signatureOf(buffer) === "zip" && /\.(bm3|bm3mat)$/i.test(file);
}

async function convertBm3ToGlb(file, zipBuffer, options) {
  try {
    const zip = unzipSync(new Uint8Array(zipBuffer));
    const manifestBytes = zip["manifest.json"];
    if (!manifestBytes) {
      return { path: file, ok: false, reason: "bm3-missing-manifest" };
    }
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
    const binaryBytes = zip["binary.bin"] || new Uint8Array();
    if (!manifest.geometries || !manifest.geometries.length) {
      return { path: file, ok: false, reason: "bm3-no-geometry" };
    }

    const basename = path.basename(file, path.extname(file));
    const binary = Buffer.from(binaryBytes);
    const requested = String(options.format || "glb").toLowerCase();
    const outputs = [];
    if (requested === "glb" || requested === "all") {
      const output = path.join(options.out, `${basename}.glb`);
      const glb = buildGlbFromBm3(manifest, binary, {
        sourceName: path.basename(file),
        scale: Number.isFinite(options.scale) ? options.scale : 0.001,
      });
      await fs.writeFile(output, glb);
      outputs.push(output);
    }
    if (requested === "obj" || requested === "all") {
      const objOutputs = await writeObjFromBm3(manifest, binary, {
        outDir: options.out,
        basename,
        scale: Number.isFinite(options.scale) ? options.scale : 0.001,
      });
      outputs.push(...objOutputs);
    }
    if (requested === "dae") {
      return {
        path: file,
        ok: false,
        reason: "dae-not-implemented",
        note: "Use --format obj for Live Home 3D imports or --format glb for normalized glTF output.",
      };
    }
    if (!outputs.length) {
      return { path: file, ok: false, reason: "unsupported-target-format", targetFormat: requested };
    }

    return {
      path: file,
      ok: true,
      output: outputs[0],
      outputs,
      format: requested,
      sourceFormat: "BM3",
      meshes: manifest.geometries.length,
      materials: (manifest.materials || []).length,
      images: (manifest.images || []).length,
    };
  } catch (error) {
    return { path: file, ok: false, reason: "bm3-conversion-failed", error: error.message };
  }
}

async function writeObjFromBm3(manifest, binary, options) {
  const objPath = path.join(options.outDir, `${options.basename}.obj`);
  const mtlPath = path.join(options.outDir, `${options.basename}.mtl`);
  const textureDir = path.join(options.outDir, `${options.basename}_textures`);
  await ensureDir(textureDir);

  const materialTextureMap = await extractBm3Images(manifest, binary, textureDir);
  const obj = [];
  const mtl = [];
  obj.push(`# Converted from ByMe BM3 by ikea-planner-assets`);
  obj.push(`mtllib ${path.basename(mtlPath)}`);

  for (let i = 0; i < (manifest.materials || []).length || i === 0; i++) {
    const material = (manifest.materials || [])[i] || {};
    const name = objMaterialName(i);
    const color = material.color || [0.8, 0.8, 0.8];
    const specular = material.specular || [0.1, 0.1, 0.1];
    mtl.push(`newmtl ${name}`);
    mtl.push(`Kd ${color[0] || 0} ${color[1] || 0} ${color[2] || 0}`);
    mtl.push(`Ks ${specular[0] || 0} ${specular[1] || 0} ${specular[2] || 0}`);
    mtl.push(`Ns ${Number.isFinite(material.shininess) ? material.shininess : 32}`);
    mtl.push(`d ${material.opacity == null ? 1 : material.opacity}`);
    if (material.diffuseMap != null && materialTextureMap.has(material.diffuseMap)) {
      mtl.push(`map_Kd ${path.relative(options.outDir, materialTextureMap.get(material.diffuseMap)).replace(/\\/g, "/")}`);
    }
    mtl.push("");
  }

  let vertexBase = 1;
  let uvBase = 1;
  let normalBase = 1;
  const transformedMeshNodes = collectMeshNodes(manifest);
  for (const { node: bmNode, matrix } of transformedMeshNodes) {
    if (bmNode.type !== "Mesh3D") continue;
    obj.push(`o ${sanitizeObjName(options.basename)}_${obj.length}`);
    obj.push(`usemtl ${objMaterialName(bmNode.material || 0)}`);
    for (const geometryIndex of bmNode.geometries || []) {
      const geometry = manifest.geometries[geometryIndex];
      const bufferIndex = geometry.vertexBuffers && geometry.vertexBuffers[0];
      const bufferDef = manifest.buffers && manifest.buffers[bufferIndex];
      const layout = manifest.vertexLayouts && manifest.vertexLayouts[geometry.vertexLayout] && manifest.vertexLayouts[geometry.vertexLayout][0];
      if (!geometry || !bufferDef || !layout) continue;
      const unpacked = unpackInterleavedGeometry(binary, bufferDef, layout, 1);
      for (const v of unpacked.positions) {
        const tv = transformPoint(matrix, v, options.scale);
        obj.push(`v ${tv[0]} ${tv[1]} ${tv[2]}`);
      }
      for (const vt of unpacked.uvs) obj.push(`vt ${vt[0]} ${1 - vt[1]}`);
      for (const vn of unpacked.normals) {
        const tvn = normalize(transformVector(matrix, vn));
        obj.push(`vn ${tvn[0]} ${tvn[1]} ${tvn[2]}`);
      }

      const count = geometry.drawingGroups && geometry.drawingGroups[0] ? geometry.drawingGroups[0].count : unpacked.positions.length;
      for (let i = 0; i + 2 < count; i += 3) {
        const a = i;
        const b = i + 1;
        const c = i + 2;
        obj.push(`f ${vertexBase + a}/${uvBase + a}/${normalBase + a} ${vertexBase + b}/${uvBase + b}/${normalBase + b} ${vertexBase + c}/${uvBase + c}/${normalBase + c}`);
      }
      vertexBase += unpacked.positions.length;
      uvBase += unpacked.uvs.length;
      normalBase += unpacked.normals.length;
    }
  }

  await fs.writeFile(objPath, `${obj.join("\n")}\n`);
  await fs.writeFile(mtlPath, `${mtl.join("\n")}\n`);
  return [objPath, mtlPath, ...materialTextureMap.values()];
}

function collectMeshNodes(manifest) {
  const nodes = manifest.nodes || [];
  const root = manifest.root == null ? 0 : manifest.root;
  const collected = [];
  const visit = (index, parentMatrix) => {
    const node = nodes[index];
    if (!node) return;
    const matrix = multiplyMatrices(parentMatrix, node.matrix || identityMatrix());
    if (node.type === "Mesh3D") collected.push({ node, matrix });
    for (const child of node.children || []) visit(child, matrix);
  };
  visit(root, identityMatrix());
  if (!collected.length) {
    for (const node of nodes) {
      if (node.type === "Mesh3D") collected.push({ node, matrix: node.matrix || identityMatrix() });
    }
  }
  return collected;
}

async function extractBm3Images(manifest, binary, textureDir) {
  const textureMap = new Map();
  const images = manifest.images || [];
  const textures = manifest.textures || [];
  for (let textureIndex = 0; textureIndex < textures.length; textureIndex++) {
    const image = images[textures[textureIndex].image];
    if (!image) continue;
    const ext = image.format === "jpg" ? "jpg" : (image.format || "bin");
    const target = path.join(textureDir, `texture_${textureIndex}.${ext}`);
    await fs.writeFile(target, binary.slice(image.byteOffset, image.byteOffset + image.byteLength));
    textureMap.set(textureIndex, target);
  }
  return textureMap;
}

function unpackInterleavedGeometry(binary, bufferDef, layout, scale) {
  const stride = layout.reduce((sum, attr) => sum + componentByteSize(attr.format) * attr.dimension, 0);
  const vertexCount = Math.floor(bufferDef.byteLength / stride);
  const offsets = {};
  let offset = 0;
  for (const attr of layout) {
    offsets[attr.attribute] = { offset, attr };
    offset += componentByteSize(attr.format) * attr.dimension;
  }
  const positions = [];
  const normals = [];
  const uvs = [];
  for (let i = 0; i < vertexCount; i++) {
    const base = bufferDef.byteOffset + i * stride;
    positions.push(readAttribute(binary, base, offsets.POSITION, scale));
    normals.push(readAttribute(binary, base, offsets.NORMAL, 1));
    uvs.push(readAttribute(binary, base, offsets.TEX_COORD_0, 1).slice(0, 2));
  }
  return { positions, normals, uvs };
}

function readAttribute(binary, base, descriptor, multiplier) {
  if (!descriptor) return [0, 0, 0];
  const values = [];
  for (let i = 0; i < descriptor.attr.dimension; i++) {
    const offset = base + descriptor.offset + i * componentByteSize(descriptor.attr.format);
    let value;
    switch (descriptor.attr.format) {
      case "FLOAT": value = binary.readFloatLE(offset); break;
      case "UNSIGNED_SHORT": value = binary.readUInt16LE(offset); break;
      case "SHORT": value = binary.readInt16LE(offset); break;
      case "UNSIGNED_BYTE": value = binary.readUInt8(offset); break;
      case "BYTE": value = binary.readInt8(offset); break;
      case "UNSIGNED_INT": value = binary.readUInt32LE(offset); break;
      default: value = 0;
    }
    values.push(Number((value * multiplier).toPrecision(8)));
  }
  return values;
}

function objMaterialName(index) {
  return `material_${index}`;
}

function sanitizeObjName(name) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, "_");
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
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

function transformPoint(m, v, scale = 1) {
  const x = v[0], y = v[1], z = v[2];
  return [
    Number(((m[0] * x + m[4] * y + m[8] * z + m[12]) * scale).toPrecision(8)),
    Number(((m[1] * x + m[5] * y + m[9] * z + m[13]) * scale).toPrecision(8)),
    Number(((m[2] * x + m[6] * y + m[10] * z + m[14]) * scale).toPrecision(8)),
  ];
}

function transformVector(m, v) {
  const x = v[0], y = v[1], z = v[2];
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [
    Number((v[0] / length).toPrecision(8)),
    Number((v[1] / length).toPrecision(8)),
    Number((v[2] / length).toPrecision(8)),
  ];
}

function buildGlbFromBm3(manifest, binary, options) {
  const json = {
    asset: {
      version: "2.0",
      generator: "ikea-planner-assets BM3 converter",
      copyright: "Source asset captured from accessible IKEA/HomeByMe planner session.",
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [],
    meshes: [],
    materials: [],
    buffers: [{ byteLength: 0 }],
    bufferViews: [],
    accessors: [],
    images: [],
    textures: [],
  };

  const chunks = [];
  const appendChunk = (source) => {
    const padding = (4 - (source.length % 4)) % 4;
    const offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    chunks.push(source);
    if (padding) chunks.push(Buffer.alloc(padding));
    return offset;
  };

  const sourceBinaryOffset = appendChunk(binary);

  for (const image of manifest.images || []) {
    const mimeType = image.format === "jpg" ? "image/jpeg" : `image/${image.format || "jpeg"}`;
    const view = {
      buffer: 0,
      byteOffset: sourceBinaryOffset + image.byteOffset,
      byteLength: image.byteLength,
    };
    json.bufferViews.push(view);
    json.images.push({
      mimeType,
      bufferView: json.bufferViews.length - 1,
      name: image.name || `image_${json.images.length}`,
    });
  }

  for (const texture of manifest.textures || []) {
    json.textures.push({ source: texture.image });
  }

  for (const material of manifest.materials || []) {
    const pbr = {
      baseColorFactor: [
        ...(material.color || [0.8, 0.8, 0.8]).slice(0, 3),
        material.opacity == null ? 1 : material.opacity,
      ],
      metallicFactor: 0,
      roughnessFactor: phongShininessToRoughness(material.shininess),
    };
    if (material.diffuseMap != null) pbr.baseColorTexture = { index: material.diffuseMap };
    json.materials.push({
      name: material.name || `material_${json.materials.length}`,
      pbrMetallicRoughness: pbr,
      alphaMode: material.opacity != null && material.opacity < 1 ? "BLEND" : "OPAQUE",
      doubleSided: Boolean(material.doubleSided),
    });
  }

  for (const bmNode of manifest.nodes || []) {
    const node = {};
    if (bmNode.matrix) node.matrix = bmNode.matrix;
    if (bmNode.children) node.children = bmNode.children.slice();
    if (bmNode.type === "Mesh3D") {
      node.mesh = json.meshes.length;
      json.meshes.push(makeMesh(json, manifest, bmNode, sourceBinaryOffset));
    }
    json.nodes.push(node);
  }

  if (!json.nodes.length) {
    json.nodes.push({ mesh: 0 });
    json.meshes.push(makeMesh(json, manifest, { geometries: manifest.geometries.map((_, i) => i), material: 0 }, sourceBinaryOffset));
  }

  const bmRoot = manifest.root == null ? 0 : manifest.root;
  json.nodes.unshift({
    name: options.sourceName,
    children: [bmRoot + 1],
    scale: [options.scale, options.scale, options.scale],
  });
  for (const node of json.nodes.slice(1)) {
    if (node.children) node.children = node.children.map((child) => child + 1);
  }
  json.scenes[0].nodes = [0];

  if (!json.materials.length) {
    json.materials.push({
      name: "default",
      pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.7 },
    });
  }

  json.buffers[0].byteLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const binChunk = Buffer.concat(chunks);
  return writeGlb(json, binChunk);
}

function makeMesh(json, manifest, bmNode, sourceBinaryOffset) {
  const primitives = [];
  for (const geometryIndex of bmNode.geometries || []) {
    const geometry = manifest.geometries[geometryIndex];
    if (!geometry) continue;
    const bufferIndex = geometry.vertexBuffers && geometry.vertexBuffers[0];
    const bufferDef = manifest.buffers && manifest.buffers[bufferIndex];
    if (!bufferDef) continue;
    const layout = manifest.vertexLayouts && manifest.vertexLayouts[geometry.vertexLayout] && manifest.vertexLayouts[geometry.vertexLayout][0];
    if (!layout) continue;

    const stride = layout.reduce((sum, attr) => sum + componentByteSize(attr.format) * attr.dimension, 0);
    const vertexCount = geometry.drawingGroups && geometry.drawingGroups[0] ? geometry.drawingGroups[0].count : Math.floor(bufferDef.byteLength / stride);
    const attributes = {};
    let attrOffset = 0;
    for (const attr of layout) {
      const semantic = gltfSemantic(attr.attribute);
      const accessorIndex = addAccessor(json, {
        byteOffset: sourceBinaryOffset + bufferDef.byteOffset + attrOffset,
        byteLength: bufferDef.byteLength - attrOffset,
        byteStride: stride,
        count: vertexCount,
        componentType: componentType(attr.format),
        type: accessorType(attr.dimension),
        target: 34962,
        min: attr.attribute === "POSITION" && geometry.boundingBox ? geometry.boundingBox.min : undefined,
        max: attr.attribute === "POSITION" && geometry.boundingBox ? geometry.boundingBox.max : undefined,
      });
      attributes[semantic] = accessorIndex;
      attrOffset += componentByteSize(attr.format) * attr.dimension;
    }
    primitives.push({
      attributes,
      material: bmNode.material != null ? bmNode.material : 0,
      mode: drawingMode(geometry.drawingGroups && geometry.drawingGroups[0] && geometry.drawingGroups[0].mode),
    });
  }
  return { primitives };
}

function addAccessor(json, def) {
  json.bufferViews.push({
    buffer: 0,
    byteOffset: def.byteOffset,
    byteLength: def.byteLength,
    byteStride: def.byteStride,
    target: def.target,
  });
  const accessor = {
    bufferView: json.bufferViews.length - 1,
    byteOffset: 0,
    componentType: def.componentType,
    count: def.count,
    type: def.type,
  };
  if (def.min) accessor.min = def.min;
  if (def.max) accessor.max = def.max;
  json.accessors.push(accessor);
  return json.accessors.length - 1;
}

function writeGlb(json, binaryChunk) {
  const jsonBuffer = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPadding = (4 - (jsonBuffer.length % 4)) % 4;
  const binPadding = (4 - (binaryChunk.length % 4)) % 4;
  const paddedJson = Buffer.concat([jsonBuffer, Buffer.alloc(jsonPadding, 0x20)]);
  const paddedBin = Buffer.concat([binaryChunk, Buffer.alloc(binPadding)]);
  const totalLength = 12 + 8 + paddedJson.length + 8 + paddedBin.length;
  const glb = Buffer.alloc(totalLength);
  let offset = 0;
  glb.writeUInt32LE(0x46546c67, offset); offset += 4;
  glb.writeUInt32LE(2, offset); offset += 4;
  glb.writeUInt32LE(totalLength, offset); offset += 4;
  glb.writeUInt32LE(paddedJson.length, offset); offset += 4;
  glb.writeUInt32LE(0x4e4f534a, offset); offset += 4;
  paddedJson.copy(glb, offset); offset += paddedJson.length;
  glb.writeUInt32LE(paddedBin.length, offset); offset += 4;
  glb.writeUInt32LE(0x004e4942, offset); offset += 4;
  paddedBin.copy(glb, offset);
  return glb;
}

function gltfSemantic(attribute) {
  if (attribute === "TEX_COORD_0") return "TEXCOORD_0";
  return attribute;
}

function accessorType(dimension) {
  return ["SCALAR", "VEC2", "VEC3", "VEC4"][dimension - 1] || "SCALAR";
}

function componentType(format) {
  switch (format) {
    case "FLOAT": return 5126;
    case "UNSIGNED_SHORT": return 5123;
    case "SHORT": return 5122;
    case "UNSIGNED_BYTE": return 5121;
    case "BYTE": return 5120;
    case "UNSIGNED_INT": return 5125;
    default: throw new Error(`Unsupported BM3 component format: ${format}`);
  }
}

function componentByteSize(format) {
  switch (format) {
    case "FLOAT":
    case "UNSIGNED_INT": return 4;
    case "UNSIGNED_SHORT":
    case "SHORT": return 2;
    case "UNSIGNED_BYTE":
    case "BYTE": return 1;
    default: throw new Error(`Unsupported BM3 component format: ${format}`);
  }
}

function drawingMode(mode) {
  if (mode === "TRIANGLES") return 4;
  if (mode === "TRIANGLE_STRIP") return 5;
  if (mode === "LINES") return 1;
  return 4;
}

function phongShininessToRoughness(shininess) {
  if (!Number.isFinite(shininess)) return 0.65;
  return Math.max(0.05, Math.min(1, Math.sqrt(2 / (shininess + 2))));
}

async function normalizeGltf(file, options) {
  try {
    const io = new NodeIO();
    const document = await io.read(file);
    await document.transform(dedup(), prune());
    const outPath = path.join(options.out, `${path.basename(file, path.extname(file))}.glb`);
    await io.write(outPath, document);
    return { path: file, ok: true, output: outPath, format: "glb" };
  } catch (error) {
    return { path: file, ok: false, reason: "gltf-conversion-failed", error: error.message };
  }
}

async function copyAsExport(file, options, note) {
  const target = path.join(options.out, path.basename(file));
  await fs.copyFile(file, target);
  return { path: file, ok: true, output: target, format: path.extname(file).slice(1).toLowerCase(), note };
}

module.exports = { convertInputs };
