"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { ensureDir, readJson, sanitizeFileName, writeJson } = require("./common");

async function nameExports(assetMapPath, options) {
  const assetMap = await readJson(assetMapPath);
  const objDir = options.objDir;
  const outDir = options.out;
  await ensureDir(outDir);

  const results = [];
  const usedNames = new Set();
  for (const asset of assetMap.assets || []) {
    if (!asset.assetFile || !asset.resource?.id) continue;
    const ext = asset.resource.extensions?.[0]?.toLowerCase();
    if (ext !== ".bm3") continue;

    const sourceBase = path.basename(asset.assetFile, path.extname(asset.assetFile));
    const sourceObj = path.join(objDir, `${sourceBase}.obj`);
    if (!(await exists(sourceObj))) continue;

    const nameBase = uniqueName(suggestExportName(asset), usedNames);
    const targetObj = path.join(outDir, `${nameBase}.obj`);
    const targetMtl = path.join(outDir, `${nameBase}.mtl`);
    const sourceMtl = path.join(objDir, `${sourceBase}.mtl`);
    const sourceTextureDir = path.join(objDir, `${sourceBase}_textures`);
    const targetTextureDir = path.join(outDir, `${nameBase}_textures`);

    const objText = await fs.readFile(sourceObj, "utf8");
    await fs.writeFile(targetObj, rewriteObjMtllib(objText, `${nameBase}.mtl`));

    if (await exists(sourceMtl)) {
      let mtlText = await fs.readFile(sourceMtl, "utf8");
      if (await exists(sourceTextureDir)) {
        await copyDir(sourceTextureDir, targetTextureDir);
        mtlText = rewriteMtlTextureDir(mtlText, path.basename(sourceTextureDir), path.basename(targetTextureDir));
      }
      await fs.writeFile(targetMtl, mtlText);
    }

    results.push({
      sourceObj,
      targetObj,
      sourceMtl: await exists(sourceMtl) ? sourceMtl : null,
      targetMtl: await exists(targetMtl) ? targetMtl : null,
      label: asset.label || null,
      resourceId: asset.resource.id,
      assetFile: asset.assetFile,
    });
  }

  const report = {
    schema: "ikea-planner-assets.named-exports.v1",
    generatedAt: new Date().toISOString(),
    inputs: { assetMap: assetMapPath, objDir, out: outDir },
    summary: { copied: results.length },
    files: results,
  };
  const reportPath = path.join(outDir, "named-exports-report.json");
  await writeJson(reportPath, report);
  console.log(`Named ${results.length} OBJ exports; wrote ${outDir}`);
  return report;
}

function suggestExportName(asset) {
  const label = asset.label || asset.resource?.id || "asset";
  const idHint = shortId(asset.resource?.id || "");
  return sanitizeFileName(`${label}__${idHint}`);
}

function shortId(id) {
  return String(id)
    .replace(/\.bm3.*$/i, "")
    .replace(/^(ASL|ASM|ART|SCP|MSC|EXT)-/i, "$1-")
    .slice(0, 72);
}

function uniqueName(name, usedNames) {
  let candidate = name || "asset";
  let i = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${name}_${i++}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function rewriteObjMtllib(text, mtlName) {
  const lines = text.split(/\r?\n/);
  let replaced = false;
  const rewritten = lines.map((line) => {
    if (line.startsWith("mtllib ")) {
      replaced = true;
      return `mtllib ${mtlName}`;
    }
    return line;
  });
  if (!replaced) rewritten.unshift(`mtllib ${mtlName}`);
  return `${rewritten.join("\n")}\n`;
}

function rewriteMtlTextureDir(text, oldDir, newDir) {
  return text.split(/\r?\n/).map((line) => {
    if (!line.startsWith("map_Kd ")) return line;
    return line.replace(oldDir, newDir);
  }).join("\n");
}

async function copyDir(source, target) {
  await ensureDir(target);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) await copyDir(sourcePath, targetPath);
    else if (entry.isFile()) await fs.copyFile(sourcePath, targetPath);
  }
}

async function exists(file) {
  return Boolean(await fs.stat(file).catch(() => null));
}

module.exports = { nameExports };
