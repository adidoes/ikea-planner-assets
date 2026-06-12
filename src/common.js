"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_ASSET_RE = /\.(br|geom|texture|mesh|bin|gltf|glb|obj|dae|fbx|ktx2|basis|dds|webp|png|jpe?g|json|zip|gz)(?:[?#].*)?$/i;
const DEFAULT_CDN_RE = /(cloudfront\.net|byme-ikea-prod\.s3\.eu-west-1\.amazonaws\.com|platform\.ikea-prod\.by\.me|kitchen\.ikea-prod\.by\.me)/i;

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function shortHash(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
}

function safeNameFromUrl(url, fallback = "asset") {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return sanitizeFileName(fallback);
  }

  const base = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || fallback);
  const cleanBase = sanitizeFileName(base) || fallback;
  return `${shortHash(url)}-${cleanBase}`;
}

function sanitizeFileName(name) {
  return String(name)
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
}

function classifyUrl(url, contentType = "") {
  const lower = url.toLowerCase();
  const pathName = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return lower;
    }
  })();
  const extension = path.extname(pathName).replace(".", "");
  let family = "other";

  if (/\.br$/i.test(pathName)) family = "brotli";
  else if (/\.(geom|mesh)$/i.test(pathName)) family = "geometry";
  else if (/\.(texture|ktx2|basis|dds)$/i.test(pathName)) family = "texture";
  else if (/\.(glb|gltf|obj|dae|fbx)$/i.test(pathName)) family = "model";
  else if (/\.(png|jpe?g|webp|gif|svg)$/i.test(pathName) || /^image\//i.test(contentType)) family = "image";
  else if (/\.json$/i.test(pathName) || /json/i.test(contentType)) family = "json";
  else if (/\.(js|mjs)$/i.test(pathName)) family = "script";
  else if (/\.css$/i.test(pathName)) family = "stylesheet";

  const likelyAsset = DEFAULT_ASSET_RE.test(url) || DEFAULT_CDN_RE.test(url);
  return { extension, family, likelyAsset };
}

async function listFiles(inputs) {
  const out = [];
  for (const input of inputs) {
    const stat = await fs.stat(input).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const children = await fs.readdir(input);
      out.push(...await listFiles(children.map((child) => path.join(input, child))));
    } else if (stat.isFile()) {
      out.push(input);
    }
  }
  return out.sort();
}

function compileMaybeRegex(value) {
  if (!value) return null;
  return new RegExp(value, "i");
}

module.exports = {
  DEFAULT_ASSET_RE,
  DEFAULT_CDN_RE,
  classifyUrl,
  compileMaybeRegex,
  ensureDir,
  listFiles,
  readJson,
  safeNameFromUrl,
  sanitizeFileName,
  sha256,
  shortHash,
  writeJson,
};
