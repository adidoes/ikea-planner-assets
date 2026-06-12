"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { unzipSync } = require("fflate");
const { ensureDir, listFiles, sha256, writeJson } = require("./common");

const brotliDecompress = promisify(zlib.brotliDecompress);
const gunzip = promisify(zlib.gunzip);

async function inspectInputs(inputs, options) {
  await ensureDir(options.out);
  const files = await listFiles(inputs);
  const results = [];
  for (const file of files) {
    if (path.basename(file).endsWith(".json") && file.includes("manifest")) continue;
    results.push(await inspectOne(file, options));
  }

  const summary = {
    total: results.length,
    byKind: countBy(results, "kind"),
    decoded: results.filter((r) => r.decodedPath).length,
    possibleGeometry: results.filter((r) => r.possibleGeometry).length,
  };
  const outPath = path.join(options.out, "analysis.json");
  await writeJson(outPath, {
    schema: "ikea-planner-assets.analysis.v1",
    generatedAt: new Date().toISOString(),
    summary,
    files: results,
  });
  console.log(`Inspected ${results.length} files; wrote ${outPath}`);
  console.log(JSON.stringify(summary, null, 2));
}

async function inspectOne(file, options) {
  const buffer = await fs.readFile(file);
  const signature = signatureOf(buffer);
  const extension = path.extname(file).replace(".", "").toLowerCase();
  const base = path.basename(file);
  const result = {
    path: file,
    name: base,
    extension,
    bytes: buffer.length,
    sha256: sha256(buffer),
    signature,
    kind: inferKind(file, buffer, signature),
  };

  const decoded = await tryDecode(file, buffer, result.kind);
  if (result.kind === "zip") {
    result.zip = inspectZip(buffer);
    if (result.zip && result.zip.bm3Manifest) {
      result.kind = result.zip.bm3Manifest.geometries ? "bm3" : "bm3mat";
      result.bm3 = result.zip.bm3Manifest;
    }
  }
  if (decoded) {
    result.decodedBytes = decoded.buffer.length;
    result.decodedKind = inferKind(decoded.name, decoded.buffer, signatureOf(decoded.buffer));
    result.decodedSignature = signatureOf(decoded.buffer);
    result.decodedSha256 = sha256(decoded.buffer);
    result.decodedPreview = preview(decoded.buffer);
    result.possibleGeometry = looksLikeGeometry(decoded.buffer);
    if (options.writeDecoded) {
      const decodedName = `${sanitizeForDecoded(base)}.${decoded.name}`;
      const decodedPath = path.join(options.out, decodedName);
      await fs.writeFile(decodedPath, decoded.buffer);
      result.decodedPath = decodedPath;
    }
  } else {
    result.preview = preview(buffer);
    result.possibleGeometry = looksLikeGeometry(buffer);
  }

  return result;
}

function inspectZip(buffer) {
  try {
    const zip = unzipSync(new Uint8Array(buffer), { filter: (file) => ["manifest.json", "binary.bin"].includes(file.name) });
    const entries = Object.entries(zip).map(([name, bytes]) => ({ name, bytes: bytes.length }));
    let bm3Manifest = null;
    if (zip["manifest.json"]) {
      const parsed = JSON.parse(Buffer.from(zip["manifest.json"]).toString("utf8"));
      if (parsed.header && parsed.header.generator && /ByMe/i.test(parsed.header.generator)) {
        bm3Manifest = {
          version: parsed.header.version,
          generator: parsed.header.generator,
          unit: parsed.header.unit,
          upAxis: parsed.header.upAxis,
          materials: (parsed.materials || []).length,
          textures: (parsed.textures || []).length,
          images: (parsed.images || []).length,
          geometries: (parsed.geometries || []).length,
          nodes: (parsed.nodes || []).length,
          vertexLayouts: (parsed.vertexLayouts || []).map((layout) => layout[0].map((attr) => `${attr.attribute}:${attr.format}${attr.dimension}`).join(",")),
        };
      }
    }
    return { entries, bm3Manifest };
  } catch (error) {
    return { error: error.message };
  }
}

async function tryDecode(file, buffer, kind) {
  const lower = file.toLowerCase();
  if (kind === "brotli" || lower.endsWith(".br")) {
    try {
      const decoded = await brotliDecompress(buffer);
      return { name: decodedExtension(decoded, "brotli.decoded"), buffer: decoded };
    } catch {
      // Some planner .br entries may be a logical extension rather than raw Brotli.
    }
  }
  if (kind === "gzip" || lower.endsWith(".gz")) {
    try {
      const decoded = await gunzip(buffer);
      return { name: decodedExtension(decoded, "gzip.decoded"), buffer: decoded };
    } catch {}
  }
  return null;
}

function decodedExtension(buffer, fallback) {
  const sig = signatureOf(buffer);
  if (sig === "json") return "json";
  if (sig === "glb") return "glb";
  if (sig === "png") return "png";
  if (sig === "jpeg") return "jpg";
  if (sig === "zip") return "zip";
  return fallback;
}

function signatureOf(buffer) {
  if (buffer.length >= 4 && buffer.slice(0, 4).toString("utf8") === "glTF") return "glb";
  if (buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 4 && buffer.slice(0, 4).toString("utf8") === "KTX ") return "ktx";
  if (buffer.length >= 4 && buffer.slice(0, 4).toString("utf8") === "PK\u0003\u0004") return "zip";
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return "gzip";
  const trimmed = buffer.slice(0, 128).toString("utf8").trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (/^#?\s*o\b/m.test(buffer.slice(0, 4096).toString("utf8"))) return "obj";
  return "binary";
}

function inferKind(file, buffer, signature) {
  const lower = file.toLowerCase();
  if (signature === "json") return "json";
  if (signature === "glb" || lower.endsWith(".gltf") || lower.endsWith(".obj") || lower.endsWith(".dae")) return "model";
  if (signature === "png" || signature === "jpeg" || lower.match(/\.(webp|gif|svg)$/)) return "image";
  if (signature === "ktx" || lower.match(/\.(texture|basis|ktx2|dds)$/)) return "texture";
  if (signature === "gzip" || lower.endsWith(".gz")) return "gzip";
  if (lower.endsWith(".br")) return "brotli";
  if (lower.match(/\.(geom|mesh)$/)) return "geometry";
  if (signature === "zip") return "zip";
  return "binary";
}

function looksLikeGeometry(buffer) {
  if (buffer.length < 64) return false;
  const sample = buffer.slice(0, Math.min(buffer.length, 1024));
  const floatCount = Math.floor(sample.length / 4);
  let plausibleFloats = 0;
  for (let i = 0; i < floatCount; i++) {
    const value = sample.readFloatLE(i * 4);
    if (Number.isFinite(value) && Math.abs(value) < 100000) plausibleFloats++;
  }
  return plausibleFloats / floatCount > 0.65;
}

function preview(buffer) {
  const text = buffer.slice(0, 256).toString("utf8");
  if (/^[\x09\x0a\x0d\x20-\x7e]+$/.test(text)) return text.replace(/\s+/g, " ").slice(0, 240);
  return buffer.slice(0, 32).toString("hex");
}

function sanitizeForDecoded(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
}

function countBy(items, field) {
  return items.reduce((acc, item) => {
    const key = item[field] || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

module.exports = { inspectInputs, inspectOne, signatureOf };
