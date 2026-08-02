"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { addProductAliases, normalizeSpaceCatalog } = require("./catalog");
const { discoverDexfApiKey, extractDexfApiKey } = require("./dexf");
const { analyzeSpaceEntities, captureSpacePlan, exportSpaceObj, resolveSpaceModels } = require("./pipeline");
const { parseSpaceReference } = require("./reference");

async function runSpaceSelfTest(options = {}) {
  const shareUrl = "https://www.ikea.com/addon-app/space/platform/latest/be/en/?vpcSource=clipboard#/open/337M5VD";
  assert.deepEqual(parseSpaceReference(shareUrl), {
    input: shareUrl,
    planId: "337M5VD",
    retailUnit: "BE",
    language: "en",
    locale: "en-BE",
    platformIndexUrl: "https://www.ikea.com/addon-app/space/platform/latest/be/en/",
    plannerUrl: shareUrl,
  });
  assert.equal(parseSpaceReference("337m5vd").planId, "337M5VD");
  assert.equal(
    parseSpaceReference("https://www.ikea.com/addon-app/space/platform/latest/nl/nl/#/room/living-room", { planId: "abcd12" }).locale,
    "nl-NL",
  );

  assert.equal(extractDexfApiKey('settings:{dexfApiKey:"fixture-public-key"}'), "fixture-public-key");
  const fakeFetch = createFakeFetch(new Map([
    ["https://example.test/space/", '<script src="vendor.js"></script><script src="static/js/index.abc.js"></script>'],
    ["https://example.test/space/static/js/index.abc.js", 'const settings={dexfApiKey:"fixture-public-key"};'],
  ]));
  const discovery = await discoverDexfApiKey("https://example.test/space/", { fetch: fakeFetch });
  assert.equal(discovery.apiKey, "fixture-public-key");
  assert.equal(discovery.bundleUrl, "https://example.test/space/static/js/index.abc.js");

  const catalog = normalizeSpaceCatalog({
    schemaVersion: "draft-02",
    rangeVersion: "fixture-v1",
    range: "seating",
    products: [
      {
        id: "79010614",
        dexf: "SPR-79010614",
        template: { id: "sofa-frame-w-cover-asm", parts: [{ id: "10072256", partKey: "frame" }, { id: "20278855", partKey: "cover" }] },
      },
      { id: "10072256", dexf: "ART-10072256", template: { id: "sofa-seat-frame", description: "KLIPPAN frame" } },
      {
        id: "20278855",
        dexf: "ART-20278855",
        modelURI: "https://content.dexf.ikea.com/cdn/asset/klippan/rt/fixture.glb",
        template: {
          id: "KLIPPAN-sofa-seat-cover",
          description: "KLIPPAN cover",
          size: { width: 1800, height: 660, depth: 880 },
          modelTransform: { p: { y: -341 } },
        },
      },
    ],
  }, { rangeId: "seating", sourceUrl: "https://example.test/catalog/", planVersion: "42" });
  const products = new Map();
  for (const product of catalog.products) addProductAliases(products, product);
  const analysis = analyzeSpaceEntities(fixturePlan(), products);
  assert.equal(analysis.productEntityCount, 3);
  assert.equal(analysis.instances.length, 1);
  assert.equal(analysis.instances[0].productId, "20278855");
  assert.equal(analysis.instances[0].label, "KLIPPAN cover for 2-seat sofa");
  assert.equal(analysis.instances[0].transform.position.x, -1203.166);
  assert.equal(analysis.instances[0].catalog.modelTransform.positionMm.y, -341);
  assert.deepEqual(analysis.skipped.map((item) => item.reason), ["assembly-container-no-model", "catalog-model-uri-missing"]);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ikea-space-self-test-"));
  try {
    const exported = await exportSpaceObj({
      planId: "FIXTURE",
      instances: [{
        ...analysis.instances[0],
        id: "triangle",
        productId: "triangle",
        transform: {
          position: { x: 1000, y: 2000, z: 3000 },
          quaternion: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
        },
        catalog: {
          ...analysis.instances[0].catalog,
          modelTransform: { positionMm: { y: -500 } },
        },
      }],
      models: new Map([["triangle", {
        key: "triangle",
        url: "fixture://triangle.glb",
        buffer: makeTriangleGlb(),
      }]]),
    }, { out: tempDir, name: "space-fixture", axis: "y-up" });
    assert.equal(exported.summary.instances, 1);
    assert.equal(exported.summary.faces, 1);
    assert.deepEqual(exported.bounds.min, [1, 1.5, 3]);
    assert.deepEqual(exported.bounds.max, [2, 2.5, 3]);
    const obj = await fs.readFile(exported.objPath, "utf8");
    assert.match(obj, /v 1 1\.5 3/);
    assert.match(obj, /f 1 2 3/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  if (options.live) await runLiveFixtureTest();
  console.log("space self-test ok");
}

async function runLiveFixtureTest() {
  const capture = await captureSpacePlan("337M5VD");
  const analysis = analyzeSpaceEntities(capture.plan, capture.catalogProducts);
  assert.equal(capture.plan.configurationId, "337M5VD");
  assert.equal(analysis.instances.length, 1);
  assert.match(analysis.instances[0].label, /KLIPPAN/i);
  const resolved = await resolveSpaceModels(analysis.instances);
  assert.equal(resolved.models.size, 1);
  assert.equal(resolved.downloads[0].modelKey, "kxmi9gu3k41q");
}

function fixturePlan() {
  const position = { x: -1203.166, y: 330, z: -1240 };
  const world = { p: position, r: { w: 1, x: 0, y: 0, z: 0 } };
  return {
    configuration: {
      content: {
        entities: [
          { id: "67", ref: "79010614", parent: "59", c: { WorldTransformComponent: world, InteractableComponent: {} } },
          { id: "68", ref: "10072256", parent: "67", c: { WorldTransformComponent: world, ProductPartComponent: { partKey: "sofa-seat-frame" } } },
          { id: "69", ref: "20278855", parent: "67", c: { WorldTransformComponent: world, ProductPartComponent: { partKey: "sofa-seat-cover" } } },
        ],
      },
    },
    icf: {
      content: {
        articles: [
          { id: 3, product_id: "SPR-79010614", name: "KLIPPAN 2-seat sofa", category: "sofas" },
          { id: 4, product_id: "ART-10072256", name: "KLIPPAN frame", category: "sofa components" },
          { id: 5, product_id: "ART-20278855", name: "KLIPPAN cover for 2-seat sofa", category: "furniture covers" },
        ],
      },
    },
  };
}

function createFakeFetch(responses) {
  return async (url) => {
    const body = responses.get(String(url));
    return new Response(body == null ? "not found" : body, {
      status: body == null ? 404 : 200,
      headers: { "content-type": "text/plain" },
    });
  };
}

function makeTriangleGlb() {
  const positions = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => positions.writeFloatLE(value, index * 4));
  const indices = Buffer.alloc(8);
  [0, 1, 2].forEach((value, index) => indices.writeUInt16LE(value, index * 2));
  const binary = Buffer.concat([positions, indices]);
  const json = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length },
      { buffer: 0, byteOffset: positions.length, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    materials: [{ name: "fixture", pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const jsonSource = Buffer.from(JSON.stringify(json));
  const jsonPadding = Buffer.alloc((4 - (jsonSource.length % 4)) % 4, 0x20);
  const jsonChunk = Buffer.concat([jsonSource, jsonPadding]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binaryHeader, binary]);
}

if (require.main === module) {
  runSpaceSelfTest({ live: process.argv.includes("--live") }).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = { runSpaceSelfTest };
