"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { extractCatalogProducts, modelKey, optimizedModelUrl } = require("./catalog");
const { mtlDiffuseLine } = require("./export-obj");
const { collectPaxInstances } = require("./pipeline");
const { parsePaxReference } = require("./reference");

async function runPaxSelfTest() {
  const url = "https://www.ikea.com/addon-app/storageone/pax/web/latest/be/en/?vpcSource=clipboard#/vpc/337LMDY";
  assert.deepEqual(parsePaxReference(url), {
    input: url,
    planId: "337LMDY",
    retailUnit: "BE",
    language: "en",
    locale: "en-BE",
    plannerUrl: url,
  });
  assert.equal(parsePaxReference("337lmdy").plannerUrl, url);

  const fixtureDir = path.resolve(__dirname, "../test/fixtures/pax");
  const catalogSource = await fs.readFile(path.join(fixtureDir, "catalog-snippet.txt"), "utf8");
  const products = extractCatalogProducts(catalogSource, "fixture://pax-catalog");
  assert.equal(products.length, 2);
  assert.equal(products[0].id, "10458220");
  assert.equal(products[1].modelTransform.positionMm.y, -1147);
  assert.equal(modelKey("https://content.dexf.ikea.com/cdn/asset/pax/rt/lpv6t943unnh_opt_webp.glb"), "lpv6t943unnh");
  assert.equal(optimizedModelUrl(products[0].modelUri), "https://content.dexf.ikea.com/cdn/asset/pax/rt/irx1eco3st5v_opt_webp.glb");
  assert.equal(
    mtlDiffuseLine([0.5019608, 0.431372553, 0.321568638, 1]),
    "Kd 0.736646952 0.688203372 0.602581867",
    "linear glTF base colors must be encoded as sRGB values in MTL files",
  );

  const plan = JSON.parse(await fs.readFile(path.join(fixtureDir, "plan.json"), "utf8"));
  const catalogMap = new Map(products.map((product) => [product.id, product]));
  const instances = collectPaxInstances(plan, catalogMap, new Map());
  assert.equal(instances.length, 2);
  assert.equal(instances[0].source, "ecs");
  assert.equal(instances[0].icfId, "1");
  assert.equal(instances[1].icfId, "3", "PAX ECS/ICF positions within 2mm should still enrich the instance");
  assert.equal(instances[1].parentIds[0], "1");
  assert.equal(instances[1].catalog.modelTransform.positionMm.y, -1147);
  console.log("pax self-test ok");
}

if (require.main === module) {
  runPaxSelfTest().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = { runPaxSelfTest };
