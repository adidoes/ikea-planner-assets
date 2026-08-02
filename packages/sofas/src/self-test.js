"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  SOFA_RANGES,
  collectSofaInstances,
  exportSofaPlan,
  extractSofaCatalog,
  parseSofaReference,
  resolveCatalogProduct,
} = require("./index");

async function runSofaSelfTest() {
  for (const range of SOFA_RANGES) {
    const reference = parseSofaReference("337m6tl", {}, range);
    assert.equal(reference.range, range);
    assert.equal(reference.code, "337M6TL");
    assert.equal(reference.plannerUrl, `https://www.ikea.com/addon-app/sofas/${range}/web/latest/be/en/#/337M6TL`);
  }
  const liveReference = parseSofaReference("https://www.ikea.com/addon-app/sofas/jattebo/web/latest/be/en/#/337M6TL");
  assert.equal(liveReference.locale, "en-BE");
  assert.equal(liveReference.kind, "public");
  assert.throws(
    () => parseSofaReference(liveReference.plannerUrl, {}, "kivik"),
    /range mismatch/i,
  );
  assert.equal(
    parseSofaReference("https://www.ikea.com/addon-app/sofas/vimle/web/latest/us/en/?productId=30455025").kind,
    "spr",
  );

  const modelUrl = "https://content.dexf.ikea.com/cdn/asset/jattebo/rt/fixture.glb";
  const catalogSource = `var e={rangeVersion:\`fixture\`,rangeName:\`JÄTTEBO\`,items:[
    {components:{meta:{familyType:\`seat\`}},id:\`seat-base\`,parameters:{size:{depth:800,width:700,height:500}}},
    {components:{modelTransform:{p:{y:-100},r:{y:0},s:{x:1,y:1,z:1}},modelURI:\`${modelUrl}\`,historicalIds:[\`seat-old\`]},description:\`Fixture seat\`,id:\`seat-green\`,inherits:[\`seat-base\`]}
  ]};export{e as default};`;
  const catalog = extractSofaCatalog(catalogSource, "fixture://catalog.js");
  assert.equal(catalog.products.size, 2);
  assert.equal(resolveCatalogProduct(catalog, "seat-old").modelUri, modelUrl);
  assert.deepEqual(resolveCatalogProduct(catalog, "seat-green").dimensionsMm, { width: 700, height: 500, depth: 800 });

  const plan = {
    application: "jattebo",
    applicationName: "JÄTTEBO",
    configurationId: "337M6TL",
    configuration: {
      version: "2.0",
      content: {
        version: "1.3",
        entities: [{
          id: "10",
          ref: "seat-green",
          parent: "2",
          c: {
            WorldTransformComponent: { p: { y: 1000 }, r: { x: 0, y: 0, z: 0, w: 1 } },
            params: { size: { width: 700, height: 500, depth: 800 } },
          },
        }],
      },
    },
  };
  const collected = collectSofaInstances(plan, catalog);
  assert.equal(collected.instances.length, 1);
  assert.equal(collected.instances[0].transform.position.y, 1000);
  assert.equal(collected.instances[0].catalog.modelTransform.positionMm.y, -100);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ikea-sofas-self-test-"));
  try {
    const result = await exportSofaPlan("337M6TL", {
      range: "jattebo",
      out: tempDir,
      name: "fixture-sofa",
      capture: {
        plan,
        catalogSource,
        catalogUrl: "fixture://catalog.js",
        modelAssets: new Map([[modelUrl, { url: modelUrl, key: "fixture", buffer: makeTriangleGlb() }]]),
      },
    });
    assert.equal(result.summary.instances, 1);
    assert.equal(result.summary.vertices, 3);
    assert.equal(result.summary.faces, 1);
    assert.equal(result.report.format, "ikea-sofa-assembly-report-v1");
    const obj = await fs.readFile(result.objPath, "utf8");
    assert.match(obj, /\nv 0 0\.9 0\n/, "world and catalog millimetre transforms must compose into metres");
    await Promise.all(result.outputs.map((output) => fs.access(output)));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  if (process.env.IKEA_SOFA_LIVE_TEST === "1") await runLiveFixtureTest();
  console.log("sofas self-test ok");
}

async function runLiveFixtureTest() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ikea-sofas-live-test-"));
  try {
    const result = await exportSofaPlan("337M6TL", {
      range: "jattebo",
      out: tempDir,
      name: "jattebo-live-fixture",
      timeoutMs: 90000,
    });
    assert.equal(result.reference.plannerUrl, "https://www.ikea.com/addon-app/sofas/jattebo/web/latest/be/en/#/337M6TL");
    assert.equal(result.capture.plan.configurationId, "337M6TL");
    assert.ok(result.capture.appVersion, "the live planner app version should be captured");
    assert.equal(result.summary.instances, 2);
    assert.ok(result.summary.vertices > 10000);
    assert.ok(result.summary.textures >= 2);
    assert.equal(result.report.warnings.length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function makeTriangleGlb() {
  const positions = floatBuffer([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = floatBuffer([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = floatBuffer([0, 0, 1, 0, 0, 1]);
  const indices = Buffer.alloc(8);
  indices.writeUInt16LE(0, 0);
  indices.writeUInt16LE(1, 2);
  indices.writeUInt16LE(2, 4);
  const binary = Buffer.concat([positions, normals, uvs, indices]);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: "fixture", pbrMetallicRoughness: { baseColorFactor: [0.25, 0.5, 0.75, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length },
      { buffer: 0, byteOffset: positions.length, byteLength: normals.length },
      { buffer: 0, byteOffset: positions.length + normals.length, byteLength: uvs.length },
      { buffer: 0, byteOffset: positions.length + normals.length + uvs.length, byteLength: 6 },
    ],
    buffers: [{ byteLength: binary.length }],
  };
  const jsonBytes = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const binaryBytes = pad(binary, 0x00);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + binaryBytes.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBytes.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binaryBytes.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonBytes, binaryHeader, binaryBytes]);
}

function floatBuffer(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function pad(buffer, byte) {
  const remainder = buffer.length % 4;
  return remainder ? Buffer.concat([buffer, Buffer.alloc(4 - remainder, byte)]) : buffer;
}

if (require.main === module) {
  runSofaSelfTest().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = { makeTriangleGlb, runSofaSelfTest };
