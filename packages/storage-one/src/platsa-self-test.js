"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { extractCatalogProducts, modelKey, optimizedModelUrl } = require("./catalog");
const { collectPlatsaInstances } = require("./pipeline");
const { parsePlatsaReference } = require("./reference");

async function runPlatsaSelfTest() {
  const url = "https://www.ikea.com/addon-app/storageone/platsa/web/latest/be/en/?vpcSource=clipboard#/vpc/337F9K6";
  assert.deepEqual(parsePlatsaReference(url), {
    input: url,
    planId: "337F9K6",
    retailUnit: "BE",
    language: "en",
    locale: "en-BE",
    plannerUrl: url,
  });
  assert.equal(parsePlatsaReference("337f9k6").planId, "337F9K6");

  const fixtureDir = path.resolve(__dirname, "../test/fixtures/platsa");
  const catalogSource = await fs.readFile(path.join(fixtureDir, "catalog-snippet.txt"), "utf8");
  const products = extractCatalogProducts(catalogSource, "fixture://catalog");
  assert.equal(products.length, 2);
  assert.equal(products[0].id, "50330951");
  assert.equal(products[1].modelTransform.positionMm.y, -22.5);
  assert.equal(modelKey("https://example.test/t8skpo0s72lj_opt_webp.glb"), "t8skpo0s72lj");
  assert.equal(optimizedModelUrl(products[0].modelUri), "https://content.dexf.ikea.com/cdn/asset/platsa/rt/2mtckf1nimxi_opt_webp.glb");

  const plan = JSON.parse(await fs.readFile(path.join(fixtureDir, "plan.json"), "utf8"));
  const catalogMap = new Map(products.map((product) => [product.id, product]));
  const instances = collectPlatsaInstances(plan, catalogMap, new Map());
  assert.equal(instances.length, 2);
  assert.equal(instances[0].source, "ecs");
  assert.equal(instances[0].icfId, "1");
  assert.equal(instances[1].parentIds[0], "1");
  assert.equal(instances[1].catalog.modelTransform.positionMm.y, -22.5);
  console.log("platsa self-test ok");
}

if (require.main === module) {
  runPlatsaSelfTest().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = { runPlatsaSelfTest };
