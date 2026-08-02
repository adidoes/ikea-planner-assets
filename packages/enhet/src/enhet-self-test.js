"use strict";

const assert = require("node:assert/strict");
const { collectEnhetInstances, indexCatalog, selectModelUri } = require("./pipeline");
const { parseEnhetReference } = require("./reference");

async function runEnhetSelfTest() {
  const url = "https://www.ikea.com/addon-app/coro3/planner/latest/be/en/#/vpc/337M6P4";
  const reference = parseEnhetReference(url);
  assert.equal(reference.planId, "337M6P4");
  assert.equal(reference.locale, "en-BE");
  assert.equal(parseEnhetReference("337m6p4").planId, "337M6P4");

  const catalog = [{
    id: "30448937",
    dexfId: "ART-30448937",
    name: "ENHET",
    category: "frames",
    shapeConfig: { size: { width: 400, height: 750, depth: 150 } },
    assets: [{ fileTypeName: "gltf-binary", url: "https://content.dexf.ikea.com/cdn/asset/kitchen-configurator-old/rt/4x4912gsgbsz.glb" }],
  }];
  assert.equal(indexCatalog(catalog).get("30448937"), catalog[0]);
  assert.match(selectModelUri(catalog[0]), /4x4912gsgbsz\.glb$/);

  const plan = { icf: { content: { articles: [{
    id: 1,
    parent_ids: [],
    child_ids: [],
    product_id: "30448937",
    name: "ENHET",
    category: "frames",
    dimensions: { x: 400, y: 750, z: 150 },
    transform: { position: { x: 3000, y: 1850, z: 75 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  }] } } };
  const instances = collectEnhetInstances(plan, catalog);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].productId, "30448937");
  assert.equal(instances[0].transform.position.y, 1850);
  console.log("enhet self-test ok");
}

if (require.main === module) runEnhetSelfTest().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

module.exports = { runEnhetSelfTest };
