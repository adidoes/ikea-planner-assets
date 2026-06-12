"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { ensureDir, listFiles, writeJson } = require("./common");

const KEYWORDS = [
  "catalog.default_agg.br",
  "FullInfos.json",
  "Metadata.json",
  ".geom",
  ".texture",
  ".br",
  "cloudfront",
  "byme-ikea-prod",
  "getAppMetaData",
  "getFullTree",
  "generateMetaData",
];

async function indexBundles(inputs, options) {
  const files = await listFiles(inputs);
  const bundles = [];
  const urls = new Set();
  const fileRefs = new Set();
  const snippets = [];

  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    if (!text) continue;
    bundles.push({ path: file, bytes: Buffer.byteLength(text) });
    for (const match of text.matchAll(/https?:\/\/[^\s"'\\<>`)]+/g)) urls.add(clean(match[0]));
    for (const match of text.matchAll(/[A-Za-z0-9_./${}:~-]+\.(?:br|geom|texture|mesh|bin|gltf|glb|obj|dae|ktx2|basis|png|jpe?g|webp|json|zip|gz)/gi)) {
      fileRefs.add(clean(match[0]));
    }
    for (const keyword of KEYWORDS) {
      let idx = -1;
      while ((idx = text.toLowerCase().indexOf(keyword.toLowerCase(), idx + 1)) !== -1 && snippets.length < 500) {
        const start = Math.max(0, idx - 180);
        const end = Math.min(text.length, idx + keyword.length + 260);
        snippets.push({
          file,
          keyword,
          snippet: text.slice(start, end).replace(/\s+/g, " "),
        });
      }
    }
  }

  const index = {
    schema: "ikea-planner-assets.bundle-index.v1",
    generatedAt: new Date().toISOString(),
    summary: {
      bundles: bundles.length,
      urls: urls.size,
      fileRefs: fileRefs.size,
      snippets: snippets.length,
    },
    bundles,
    urls: Array.from(urls).sort(),
    fileRefs: Array.from(fileRefs).sort(),
    snippets,
  };
  await ensureDir(path.dirname(options.out));
  await writeJson(options.out, index);
  console.log(`Indexed ${bundles.length} bundles; wrote ${options.out}`);
  console.log(JSON.stringify(index.summary, null, 2));
}

function clean(value) {
  return value.replace(/[),.;]+$/, "");
}

module.exports = { indexBundles };
