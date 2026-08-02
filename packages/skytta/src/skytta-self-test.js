"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  normalizeSkyttaProducts,
  selectSkyttaAsset,
  skyttaProductsUrl,
} = require("./catalog");
const {
  analyzeSkyttaEntities,
  captureSkyttaPlan,
  exportSkyttaPlan,
  resolveSkyttaModels,
} = require("./pipeline");
const { parseSkyttaReference, skyttaCodeFromUrl } = require("./reference");

async function runSkyttaSelfTest(options = {}) {
  const plannerUrl = "https://www.ikea.com/addon-app/skytta/web/latest/be/en/?designCode=337M6KW#/planner";
  assert.deepEqual(parseSkyttaReference(plannerUrl), {
    input: plannerUrl,
    code: "337M6KW",
    planId: "337M6KW",
    retailUnit: "BE",
    language: "en",
    locale: "en-BE",
    platformIndexUrl: "https://www.ikea.com/addon-app/skytta/web/latest/be/en/",
    plannerUrl,
  });
  assert.equal(parseSkyttaReference("337m6kw").planId, "337M6KW");
  assert.equal(skyttaCodeFromUrl(new URL("https://example.test/?configurationId=ab12cd")), "AB12CD");
  assert.equal(parseSkyttaReference("https://www.ikea.com/addon-app/skytta/web/latest/nl/nl/?designCode=ABC123").locale, "nl-NL");
  assert.match(skyttaProductsUrl(parseSkyttaReference("337M6KW")), /filter\.appId=skytta/);

  const normalized = normalizeSkyttaProducts(fixtureProducts(), "https://example.test/products");
  assert.equal(normalized.productList.length, 4);
  const rail = normalized.products.get("20512641");
  assert.equal(rail.assets.length, 2);
  assert.equal(selectSkyttaAsset(rail, "20512641--top").modelKey, "top");
  assert.equal(selectSkyttaAsset(rail, "20512641--bottom").modelKey, "bottom");
  assert.equal(selectSkyttaAsset(rail, "20512641", { c: { RailComponent: { railType: 1 } } }).modelKey, "bottom");

  const analysis = analyzeSkyttaEntities(fixturePlan(), normalized.products);
  assert.equal(analysis.productEntityCount, 5);
  assert.equal(analysis.instances.length, 5);
  assert.equal(analysis.skipped.length, 0);
  assert.equal(analysis.bomOnlyItems.length, 1);
  assert.deepEqual(new Set(analysis.instances.map((instance) => instance.catalog.modelKey)), new Set(["top", "bottom", "frame", "panel"]));
  assert.equal(analysis.instances.find((instance) => instance.entityRef.endsWith("--top")).dimensionsMm.width, 2000);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ikea-skytta-self-test-"));
  try {
    const glb = makeTriangleGlb();
    const fakeFetch = createModelFetch(new Map([
      ["https://content.dexf.ikea.com/cdn/asset/skytta/rt/top.glb", glb],
      ["https://content.dexf.ikea.com/cdn/asset/skytta/rt/bottom.glb", glb],
      ["https://content.dexf.ikea.com/cdn/asset/skytta/rt/frame.glb", glb],
      ["https://content.dexf.ikea.com/cdn/asset/sliding_door_panels/rt/panel.glb", glb],
    ]));
    const report = await exportSkyttaPlan("337M6KW", {
      out: tempDir,
      name: "skytta-fixture",
      fetch: fakeFetch,
      capture: {
        plan: fixturePlan(),
        productPayload: fixtureProducts(),
        productsUrl: "https://example.test/products",
      },
    });
    assert.equal(report.schema, "ikea-planner-assets.skytta-export.v1");
    assert.equal(report.summary.instances, 5);
    assert.equal(report.summary.faces, 5);
    assert.equal(report.summary.uniqueModels, 4);
    assert.equal(report.summary.billOfMaterialOnlyItems, 1);
    assert.equal(report.modelAssociations.length, 4);
    assert.equal(report.downloads.length, 4);
    assert.equal(report.limitations.length, 5);
    const obj = await fs.readFile(report.objPath, "utf8");
    assert.match(obj, /mtllib skytta-fixture\.mtl/);
    assert.equal((obj.match(/^f /gm) || []).length, 5);
    const savedReport = JSON.parse(await fs.readFile(report.reportPath, "utf8"));
    assert.equal(savedReport.summary.exportableInstances, 5);
    assert.equal((await fs.readdir(path.join(tempDir, "skytta-fixture_source", "models"))).length, 4);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  if (options.live) await runLiveFixtureTest();
  console.log("skytta self-test ok");
}

async function runLiveFixtureTest() {
  const capture = await captureSkyttaPlan("337M6KW");
  const analysis = analyzeSkyttaEntities(capture.plan, capture.products);
  assert.equal(capture.plan.configurationId, "337M6KW");
  assert.equal(capture.plan.icf.content.application_version, "6.0.3");
  assert.equal(analysis.productEntityCount, 12);
  assert.equal(analysis.instances.length, 12);
  assert.equal(analysis.skipped.length, 0);
  assert.deepEqual(
    new Set(analysis.instances.map((instance) => instance.catalog.modelKey)),
    new Set(["ashat101a7vf", "0vkeh65rsmfc", "byoen8xi0bf9", "lzpvm9slt82n"]),
  );
  const resolved = await resolveSkyttaModels(analysis.instances);
  assert.equal(resolved.models.size, 4);
  assert.equal(resolved.assets.size, 4);
  assert.equal(resolved.warnings.length, 0);

  const out = await fs.mkdtemp(path.join(os.tmpdir(), "ikea-skytta-live-test-"));
  try {
    const report = await exportSkyttaPlan("337M6KW", { out, name: "skytta-337M6KW-live" });
    assert.equal(report.summary.instances, 12);
    assert.equal(report.summary.uniqueModels, 4);
    assert.ok(report.summary.faces > 0);
    assert.ok(report.summary.textures >= 4);
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
}

function fixturePlan() {
  const entity = (id, ref, component, position) => ({
    id: String(id),
    ref,
    parent: "scene",
    c: {
      WorldTransformComponent: { p: position, r: { w: 1, x: 0, y: 0, z: 0 } },
      params: { size: component === "PanelComponent" ? { width: 1010, height: 575, depth: 4 } : component === "SlidingDoorFrameComponent" ? { width: 1021, height: 2310, depth: 29 } : { width: 2000, height: 76, depth: 81 } },
      [component]: component === "RailComponent" ? { railType: ref.endsWith("--top") ? 0 : 1 } : {},
    },
  });
  return {
    configurationId: "337M6KW",
    application: "skytta",
    applicationName: "SKYTTA",
    itemList: { item: [
      { itemType: "ART", itemNo: "20512641", quantity: 1 },
      { itemType: "ART", itemNo: "70497737", quantity: 2 },
      { itemType: "ART", itemNo: "30510905", quantity: 2 },
      { itemType: "ART", itemNo: "10500064", quantity: 1 },
    ] },
    configuration: { version: "1.0", content: { version: "1.3", entities: [
      entity(1, "20512641--top", "RailComponent", { x: 0, y: 2400, z: 0 }),
      entity(2, "20512641--bottom", "RailComponent", { x: 0, y: 0, z: 0 }),
      entity(3, "70497737", "SlidingDoorFrameComponent", { x: -500, y: 1175, z: 20 }),
      entity(4, "30510905--default", "PanelComponent", { x: -500, y: 300, z: 25 }),
      entity(5, "30510905--default", "PanelComponent", { x: 500, y: 300, z: -25 }),
      { id: "room", ref: "", c: { RoomPartComponent: { type: 4 } } },
    ] } },
    icf: { content: { application_version: "6.0.3" } },
  };
}

function fixtureProducts() {
  const asset = (name, rangeFamily, key) => ({
    code: `asset-${key}`,
    name,
    rangeFamily,
    model: [{ fileTypeName: "gltf-binary", levelOfDetail: "rt", pivot: "ccc", url: `https://content.dexf.ikea.com/cdn/asset/${rangeFamily}/rt/${key}.glb` }],
  });
  const item = (id, name, typeName, assets, measure = []) => ({
    valid: true,
    itemId: `ART-${id}`,
    content: { ruItemNo: id, itemNoGlobal: id, name, typeName, mainTypeName: typeName, assetV2: assets, measure },
  });
  return { data: [
    item("20512641", "SKYTTA", "rail for sliding door frame", [asset("20512641_up", "skytta", "top"), asset("20512641_low", "skytta", "bottom")]),
    item("70497737", "SKYTTA", "sliding door frame", [asset("70497737", "skytta", "frame")]),
    item("30510905", "MEHAMN", "4 panels for sliding door frame", [asset("30510905", "sliding_door_panels", "panel")]),
    item("10500064", "SKYTTA", "fitting package", [asset("10500064", "skytta", "fittings")]),
  ] };
}

function createModelFetch(models) {
  return async (url) => {
    const body = models.get(String(url));
    return new Response(body || "not found", {
      status: body ? 200 : 404,
      headers: { "content-type": body ? "model/gltf-binary" : "text/plain" },
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
  const jsonChunk = Buffer.concat([jsonSource, Buffer.alloc((4 - (jsonSource.length % 4)) % 4, 0x20)]);
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
  runSkyttaSelfTest({ live: process.argv.includes("--live") }).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = { runSkyttaSelfTest };
