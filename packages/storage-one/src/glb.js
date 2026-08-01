"use strict";

const fsSync = require("node:fs");
const path = require("node:path");

let dracoModulePromise = null;

async function decodeGlb(input) {
  const { json, binary } = parseGlb(input);
  const primitivesByMesh = [];
  for (const mesh of json.meshes || []) {
    const primitives = [];
    for (const primitive of mesh.primitives || []) {
      primitives.push(await decodePrimitive(json, binary, primitive));
    }
    primitivesByMesh.push(primitives);
  }

  const renderedPrimitives = [];
  for (const { node, matrix } of collectMeshNodes(json)) {
    for (const primitive of primitivesByMesh[node.mesh] || []) {
      renderedPrimitives.push({ ...primitive, matrix, nodeName: node.name || null });
    }
  }

  return {
    json,
    primitives: renderedPrimitives,
    materials: (json.materials || []).map((material, index) => decodeMaterial(json, material, index)),
    images: extractImages(json, binary),
  };
}

function parseGlb(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67) {
    throw new Error("Expected a binary glTF (GLB) file");
  }
  if (buffer.readUInt32LE(4) !== 2) throw new Error(`Unsupported GLB version ${buffer.readUInt32LE(4)}`);
  const declaredLength = buffer.readUInt32LE(8);
  if (declaredLength > buffer.length) throw new Error("Truncated GLB file");
  let json = null;
  let binary = Buffer.alloc(0);
  let offset = 12;
  while (offset + 8 <= declaredLength) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8").replace(/\0+$/, ""));
    else if (type === 0x004e4942) binary = data;
    offset += 8 + length;
  }
  if (!json) throw new Error("GLB is missing its JSON chunk");
  return { json, binary };
}

async function decodePrimitive(json, binary, primitive) {
  const draco = primitive.extensions?.KHR_draco_mesh_compression;
  let geometry;
  if (draco) geometry = await decodeDracoPrimitive(json, binary, draco);
  else geometry = decodePlainPrimitive(json, binary, primitive);
  return {
    ...geometry,
    material: primitive.material == null ? 0 : primitive.material,
    mode: primitive.mode == null ? 4 : primitive.mode,
  };
}

async function decodeDracoPrimitive(json, binary, extension) {
  const module = await loadDracoModule();
  const compressed = bufferViewBytes(json, binary, extension.bufferView);
  const decoderBuffer = new module.DecoderBuffer();
  const decoder = new module.Decoder();
  const mesh = new module.Mesh();
  try {
    decoderBuffer.Init(new Int8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength), compressed.byteLength);
    const type = decoder.GetEncodedGeometryType(decoderBuffer);
    if (type !== module.TRIANGULAR_MESH) throw new Error("Draco payload is not a triangular mesh");
    const status = decoder.DecodeBufferToMesh(decoderBuffer, mesh);
    if (!status.ok() || !mesh.ptr) throw new Error(`Draco decode failed: ${status.error_msg()}`);

    const attributes = {};
    for (const [semantic, uniqueId] of Object.entries(extension.attributes || {})) {
      const attribute = decoder.GetAttributeByUniqueId(mesh, uniqueId);
      if (!attribute || !attribute.ptr) continue;
      const componentCount = attribute.num_components();
      const values = new module.DracoFloat32Array();
      try {
        if (!decoder.GetAttributeFloatForAllPoints(mesh, attribute, values)) continue;
        const out = new Float32Array(mesh.num_points() * componentCount);
        for (let i = 0; i < out.length; i++) out[i] = values.GetValue(i);
        attributes[semantic] = { values: out, componentCount };
      } finally {
        module.destroy(values);
      }
    }

    const face = new module.DracoInt32Array();
    const indices = new Uint32Array(mesh.num_faces() * 3);
    try {
      for (let i = 0; i < mesh.num_faces(); i++) {
        decoder.GetFaceFromMesh(mesh, i, face);
        indices[i * 3] = face.GetValue(0);
        indices[i * 3 + 1] = face.GetValue(1);
        indices[i * 3 + 2] = face.GetValue(2);
      }
    } finally {
      module.destroy(face);
    }
    return attributesToGeometry(attributes, indices);
  } finally {
    module.destroy(mesh);
    module.destroy(decoder);
    module.destroy(decoderBuffer);
  }
}

function decodePlainPrimitive(json, binary, primitive) {
  const attributes = {};
  for (const [semantic, accessorIndex] of Object.entries(primitive.attributes || {})) {
    attributes[semantic] = readAccessor(json, binary, accessorIndex);
  }
  const vertexCount = attributes.POSITION?.values.length / (attributes.POSITION?.componentCount || 3) || 0;
  const indexAccessor = primitive.indices == null ? null : readAccessor(json, binary, primitive.indices);
  const indices = indexAccessor
    ? Uint32Array.from(indexAccessor.values)
    : Uint32Array.from({ length: vertexCount }, (_, index) => index);
  return attributesToGeometry(attributes, indices);
}

function attributesToGeometry(attributes, indices) {
  if (!attributes.POSITION) throw new Error("GLB primitive is missing POSITION data");
  return {
    positions: attributes.POSITION.values,
    positionSize: attributes.POSITION.componentCount,
    normals: attributes.NORMAL?.values || null,
    normalSize: attributes.NORMAL?.componentCount || 3,
    uvs: attributes.TEXCOORD_0?.values || null,
    uvSize: attributes.TEXCOORD_0?.componentCount || 2,
    indices,
  };
}

function readAccessor(json, binary, accessorIndex) {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`Missing glTF accessor ${accessorIndex}`);
  if (accessor.sparse) throw new Error("Sparse glTF accessors are not supported");
  const view = json.bufferViews?.[accessor.bufferView];
  if (!view) throw new Error(`Missing glTF buffer view ${accessor.bufferView}`);
  const componentCount = componentCountForType(accessor.type);
  const componentBytes = componentByteSize(accessor.componentType);
  const stride = view.byteStride || componentCount * componentBytes;
  const start = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const values = new Float64Array(accessor.count * componentCount);
  for (let row = 0; row < accessor.count; row++) {
    for (let component = 0; component < componentCount; component++) {
      const value = readComponent(binary, start + row * stride + component * componentBytes, accessor.componentType);
      values[row * componentCount + component] = accessor.normalized
        ? normalizeComponent(value, accessor.componentType)
        : value;
    }
  }
  return { values, componentCount };
}

function collectMeshNodes(json) {
  const nodes = json.nodes || [];
  const scenes = json.scenes || [];
  const scene = scenes[json.scene == null ? 0 : json.scene];
  let roots = scene?.nodes || [];
  if (!roots.length) {
    const children = new Set(nodes.flatMap((node) => node.children || []));
    roots = nodes.map((_, index) => index).filter((index) => !children.has(index));
  }
  const out = [];
  const visit = (index, parentMatrix) => {
    const node = nodes[index];
    if (!node) return;
    const matrix = multiplyMatrices(parentMatrix, matrixFromGltfNode(node));
    if (node.mesh != null) out.push({ node, matrix });
    for (const child of node.children || []) visit(child, matrix);
  };
  for (const root of roots) visit(root, identityMatrix());
  return out;
}

function decodeMaterial(json, material, index) {
  const pbr = material.pbrMetallicRoughness || {};
  const textureIndex = pbr.baseColorTexture?.index;
  let imageIndex = null;
  if (textureIndex != null) {
    const texture = json.textures?.[textureIndex] || {};
    imageIndex = texture.extensions?.EXT_texture_webp?.source;
    if (imageIndex == null) imageIndex = texture.source;
  }
  return {
    index,
    name: material.name || `material_${index}`,
    baseColor: (pbr.baseColorFactor || [0.8, 0.8, 0.8, 1]).slice(),
    metallic: pbr.metallicFactor == null ? 0 : pbr.metallicFactor,
    roughness: pbr.roughnessFactor == null ? 0.7 : pbr.roughnessFactor,
    doubleSided: Boolean(material.doubleSided),
    alphaMode: material.alphaMode || "OPAQUE",
    imageIndex,
  };
}

function extractImages(json, binary) {
  return (json.images || []).map((image, index) => {
    let buffer = null;
    if (image.bufferView != null) buffer = Buffer.from(bufferViewBytes(json, binary, image.bufferView));
    else if (/^data:/i.test(image.uri || "")) buffer = Buffer.from(image.uri.split(",", 2)[1] || "", "base64");
    return {
      index,
      name: image.name || `image_${index}`,
      mimeType: image.mimeType || mimeTypeFromUri(image.uri),
      uri: image.uri || null,
      buffer,
    };
  });
}

function bufferViewBytes(json, binary, index) {
  const view = json.bufferViews?.[index];
  if (!view) throw new Error(`Missing glTF buffer view ${index}`);
  return binary.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
}

async function loadDracoModule() {
  if (!dracoModulePromise) dracoModulePromise = instantiateDracoModule();
  return dracoModulePromise;
}

async function instantiateDracoModule() {
  const wrapperPath = require.resolve("three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js");
  const wasmPath = require.resolve("three/examples/jsm/libs/draco/gltf/draco_decoder.wasm");
  const source = fsSync.readFileSync(wrapperPath, "utf8");
  const cjsModule = { exports: {} };
  const evaluate = new Function("module", "exports", "require", "__filename", "__dirname", source);
  evaluate(cjsModule, cjsModule.exports, require, wrapperPath, path.dirname(wrapperPath));
  if (typeof cjsModule.exports !== "function") throw new Error("Could not load the bundled Draco decoder");
  return cjsModule.exports({ wasmBinary: fsSync.readFileSync(wasmPath) });
}

function matrixFromGltfNode(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
  return composeMatrix({
    position: arrayVector(node.translation, [0, 0, 0]),
    quaternion: arrayQuaternion(node.rotation),
    scale: arrayVector(node.scale, [1, 1, 1]),
  });
}

function composeMatrix({ position = {}, quaternion = null, rotationDegrees = null, scale = {} } = {}) {
  const q = quaternion || quaternionFromEulerDegrees(rotationDegrees || {});
  const x = q.x || 0, y = q.y || 0, z = q.z || 0, w = q.w == null ? 1 : q.w;
  const sx = scale.x == null ? 1 : scale.x;
  const sy = scale.y == null ? 1 : scale.y;
  const sz = scale.z == null ? 1 : scale.z;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    position.x || 0, position.y || 0, position.z || 0, 1,
  ];
}

function quaternionFromEulerDegrees(rotation = {}) {
  const x = (rotation.x || 0) * Math.PI / 360;
  const y = (rotation.y || 0) * Math.PI / 360;
  const z = (rotation.z || 0) * Math.PI / 360;
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z);
  const s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

function multiplyMatrices(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] +
        a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] +
        a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function transformPoint(matrix, point) {
  const x = point[0], y = point[1], z = point[2];
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function transformDirection(matrix, vector) {
  const x = vector[0], y = vector[1], z = vector[2];
  const out = [
    matrix[0] * x + matrix[4] * y + matrix[8] * z,
    matrix[1] * x + matrix[5] * y + matrix[9] * z,
    matrix[2] * x + matrix[6] * y + matrix[10] * z,
  ];
  const length = Math.hypot(...out) || 1;
  return out.map((value) => value / length);
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function arrayVector(value, fallback) {
  const array = value || fallback;
  return { x: array[0], y: array[1], z: array[2] };
}

function arrayQuaternion(value) {
  if (!value) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: value[0], y: value[1], z: value[2], w: value[3] };
}

function componentCountForType(type) {
  return { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }[type] || 1;
}

function componentByteSize(type) {
  return { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[type] || 0;
}

function readComponent(buffer, offset, type) {
  switch (type) {
    case 5120: return buffer.readInt8(offset);
    case 5121: return buffer.readUInt8(offset);
    case 5122: return buffer.readInt16LE(offset);
    case 5123: return buffer.readUInt16LE(offset);
    case 5125: return buffer.readUInt32LE(offset);
    case 5126: return buffer.readFloatLE(offset);
    default: throw new Error(`Unsupported glTF component type ${type}`);
  }
}

function normalizeComponent(value, type) {
  switch (type) {
    case 5120: return Math.max(value / 127, -1);
    case 5121: return value / 255;
    case 5122: return Math.max(value / 32767, -1);
    case 5123: return value / 65535;
    case 5125: return value / 4294967295;
    default: return value;
  }
}

function mimeTypeFromUri(uri = "") {
  if (/\.webp(?:[?#]|$)/i.test(uri)) return "image/webp";
  if (/\.png(?:[?#]|$)/i.test(uri)) return "image/png";
  return "image/jpeg";
}

module.exports = {
  composeMatrix,
  decodeGlb,
  identityMatrix,
  multiplyMatrices,
  parseGlb,
  quaternionFromEulerDegrees,
  transformDirection,
  transformPoint,
};
