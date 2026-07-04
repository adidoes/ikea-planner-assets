"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const assert = require("node:assert/strict");
const { assembleInputs } = require("./assemble");
const { materialExportProfile } = require("./convert");
const { extractEntries } = require("./import-requests");
const { inspectOne } = require("./inspect");

const brotliCompress = promisify(zlib.brotliCompress);

async function runSelfTest() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ikea-assets-test-"));
  const agentBrowserJson = JSON.stringify({
    success: true,
    data: {
      requests: [
        {
          url: "https://d1rnl1hhzmmov0.cloudfront.net/catalog.default_agg.br",
          method: "GET",
          mimeType: "application/octet-stream",
          status: 200,
          resourceType: "Fetch",
        },
      ],
    },
  });
  const entries = extractEntries(agentBrowserJson, "network.json");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url.includes("catalog.default_agg.br"), true);

  const brPath = path.join(temp, "sample.br");
  await fs.writeFile(brPath, await brotliCompress(Buffer.from(JSON.stringify({ hello: "planner" }))));
  const result = await inspectOne(brPath, { out: temp, writeDecoded: true });
  assert.equal(result.kind, "brotli");
  assert.equal(result.decodedKind, "json");
  assert.ok(result.decodedPath);

  const chromeProfile = materialExportProfile({
    color: [0, 0, 0],
    specular: [0.843137, 0.843137, 0.831373],
    shininess: 245,
  });
  assert.equal(chromeProfile.source, "chrome-phong-fallback");
  assert.equal(chromeProfile.metallicFactor, 1);
  assert.ok(chromeProfile.baseColor.every((channel) => channel > 0.6), "chrome Phong materials should export with visible diffuse color");

  await runAssemblyGeometryTests(temp);

  console.log("self-test ok");
}

async function runAssemblyGeometryTests(temp) {
  const assetMapPath = path.join(temp, "asset-map.json");
  const objDir = path.join(temp, "obj");
  await fs.mkdir(objDir, { recursive: true });
  await fs.writeFile(path.join(objDir, "embedded-panel.obj"), simplePanelObj());
  await fs.writeFile(assetMapPath, JSON.stringify({
    assets: [{
      assetFile: path.join(temp, "embedded-panel.BM3"),
      resource: { id: "PANEL-ASSET", extensions: [".bm3"] },
      label: "Embedded test panel",
    }],
  }));

  const embeddedProjectPath = path.join(temp, "embedded-assembly.BMPROJ");
  await fs.writeFile(embeddedProjectPath, JSON.stringify(embeddedAssemblyProject()));
  const embedded = await assembleInputs(embeddedProjectPath, assetMapPath, {
    objDir,
    out: path.join(temp, "embedded-out"),
    whole: true,
    worktops: false,
    flat: true,
    axis: "y-up",
    name: "embedded-assembly",
    internalParts: "keep",
  });
  assert.equal(embedded.root.furnitureCount, 1, "embedded furniture without dbId should be included as a root");
  assert.equal(embedded.summary.leaves, 1, "embedded furniture assembly should resolve child BM3 leaves");
  assert.equal(embedded.placements[0].dbId, null);
  assert.equal(embedded.placements[0].label, "CUSTOM-CABINET");
  assert.equal(embedded.leaves[0].instance.uuid, "embedded-cabinet");
  assert.equal(embedded.leaves[0].dbId, "PANEL-ASSET");

  const alignedProjectPath = path.join(temp, "aligned-corner.BMPROJ");
  await fs.writeFile(alignedProjectPath, JSON.stringify(cornerAlignmentProject()));
  const aligned = await assembleInputs(alignedProjectPath, assetMapPath, {
    objDir,
    out: path.join(temp, "aligned-out"),
    whole: true,
    worktops: true,
    flat: true,
    axis: "y-up",
    name: "aligned-corner",
    internalParts: "omit",
  });
  const fillerSlabs = aligned.proceduralWorktops.filter((slab) => slab.furnitureIDs.includes("filler"));
  const filler = aligned.proceduralWorktops.find((slab) => slab.embeddedWorktopSketch && worldRect(slab).y.min < 0);
  const cabinet = aligned.proceduralWorktops.find((slab) => slab.embeddedWorktopSketch && worldRect(slab).y.max > 1000);
  assert.ok(filler, "expected filler worktop slab");
  assert.ok(cabinet, "expected cabinet worktop slab");
  assert.equal(fillerSlabs.length, 2, "embedded IKEA worktop sketches should keep both board polygons associated with the linear");
  assert.equal(aligned.proceduralWorktops.every((slab) => slab.embeddedWorktopSketch), true, "planner worktop sketches should override heuristic slab generation");
  assertNear(unionRect([filler]).width, 690, "filler worktop should use IKEA's computed board width");
  assertNear(unionRect([filler]).depth, 635, "filler worktop should use IKEA's computed board depth");
  assertNear(unionRect([cabinet]).width, 635, "cabinet worktop should use IKEA's computed board width");
  assertNear(unionRect([cabinet]).depth, 840, "cabinet worktop should use IKEA's computed board run length");
  assert.equal(
    aligned.proceduralWorktops.every((slab) => slab.altitude === 880),
    true,
    "embedded worktop sketches should preserve planner altitude instead of using tall visible sink-front bounding boxes",
  );
  assertNear(worldRect(filler).x.max, worldRect(cabinet).x.max, "joined corner slabs should share the wall-side edge");
  assertNear(worldRect(filler).x.min, 4490.959463715553, "filler board should preserve IKEA sketch min x");
  assertNear(worldRect(filler).y.min, -193.0069974660873, "filler board should preserve IKEA sketch min y");
  assertNear(worldRect(filler).y.max, 441.9930128157139, "filler board should preserve IKEA sketch max y");
  assertNear(worldRect(cabinet).x.min, 4545.959471583366, "cabinet board should preserve IKEA sketch min x");
  assertNear(worldRect(cabinet).y.min, 441.99301118510107, "cabinet board should preserve IKEA sketch min y");
  assert.ok(rectOverlap(filler, cabinet).area < 0.01, "embedded corner slabs should meet at a seam without meaningful overlap");
  assert.equal(aligned.summary.proceduralPlinths, 2);
  assertNear(aligned.proceduralPlinths[0].height, 80, "plinth height");
  assertNear(aligned.proceduralPlinths[0].thickness, 10, "plinth thickness");
  assertNear(aligned.proceduralPlinths[0].length, 500, "first plinth path segment length");

  const bridgeProjectPath = path.join(temp, "corner-bridge.BMPROJ");
  await fs.writeFile(bridgeProjectPath, JSON.stringify(cornerBridgeProject()));
  const bridged = await assembleInputs(bridgeProjectPath, assetMapPath, {
    objDir,
    out: path.join(temp, "bridge-out"),
    whole: true,
    worktops: true,
    flat: true,
    axis: "y-up",
    name: "corner-bridge",
    internalParts: "omit",
  });
  const bridge = bridged.proceduralWorktops.find((slab) => slab.cornerBridge);
  assert.ok(bridge, "expected a procedural corner bridge for the small perpendicular gap");
  assert.equal(bridged.summary.worktopCornerBridges, 1);
  assertNear(bridge.size.depth, 57.5, "corner bridge should fill the 57.5mm join gap");
}

function cornerAlignmentProject() {
  return projectWith({
    furnitures: [
      furniture("filler", "ASM-42461142-BE", [
        -1, 1.4901161193847656e-8, 0, 0,
        -1.4901161193847656e-8, -1, 0, 0,
        0, 0, 1, 0,
        4580.95947265625, 406.9930114746094, 0, 1,
      ], { width: 100, depth: 600, leftWidth: 75, rightWidth: 75 }, {
        min: { x: -600, y: -75, z: 80 },
        max: { x: 75, y: 600, z: 880 },
      }),
      furniture("cabinet", "ASL-CABINET", [
        -4.2862638516991895e-16, -1, 0, 0,
        1, -4.2862638516991895e-16, 0, 0,
        0, 0, 1, 0,
        4880.95947265625, 881.9929809570312, 0, 1,
      ], { width: 800, depth: 600 }, {
        min: { x: -400, y: -350.5, z: 0 },
        max: { x: 400.001, y: 300, z: 882 },
      }),
      furniture("visible-front-sink", "ASL-SINK", [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        5500, 0, 0, 1,
      ], { width: 800, depth: 600 }, {
        min: { x: -400, y: -350.5, z: 0 },
        max: { x: 400.001, y: 300, z: 1276 },
      }),
    ],
    worktops: [{
      uuid: "worktop-align",
      furnitureIDs: ["filler", "cabinet", "visible-front-sink"],
      productInfoDbId: "MAT-WORKTOP",
      startOverhang: 15,
      endOverhang: 0,
      thickness: 20,
      altitude: 880,
      parameters: { depth: { value: 635 } },
    }],
    plinths: [{
      uuid: "plinth-linear",
      furnitureIDs: ["filler", "cabinet"],
      productInfoDbId: "MAT-PLINTH",
      parameters: {
        depth: { value: 10 },
        height: { value: 80 },
      },
    }],
    linearTypeMap: { "plinth-path": "Plinth", "worktop-linear": "Worktop" },
    linearFurnitures: [plinthPathFurniture("plinth-path"), worktopSketchFurniture("worktop-linear")],
  });
}

function embeddedAssemblyProject() {
  return projectWith({
    furnitures: [{
      uuid: "embedded-cabinet",
      transfo: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        100, 200, 0, 1,
      ],
      boundingBox: {
        min: { x: -300, y: -300, z: 0 },
        max: { x: 300, y: 300, z: 2400 },
      },
      parametersConfig: [
        { paramID: "width", value: 600 },
        { paramID: "child", value: { dbId: "PANEL-ASSET" } },
      ],
      embedResourceInfo: {
        assembly: {
          uuid: "embedded-root",
          name: "CUSTOM-CABINET",
          parameters: [
            { type: "component", name: "child", value: { protocol: "product", referenceValue: { dbId: "PANEL-ASSET" } } },
            { type: "number", name: "width", value: 400 },
          ],
          relations: [],
          components: [{
            name: "PANEL",
            reference: "child",
            activated: true,
            overloads: [{ parameter: "width", value: "width" }],
          }],
        },
      },
    }],
  });
}

function cornerBridgeProject() {
  return projectWith({
    furnitures: [
      furniture("x-run", "ASL-X", [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        300, 0, 0, 1,
      ], { width: 600, depth: 600 }, {
        min: { x: -300, y: -300, z: 0 },
        max: { x: 300, y: 300, z: 880 },
      }),
      furniture("y-run", "ASL-Y", [
        0, 1, 0, 0,
        -1, 0, 0, 0,
        0, 0, 1, 0,
        300, 775, 0, 1,
      ], { width: 800, depth: 600 }, {
        min: { x: -400, y: -300, z: 0 },
        max: { x: 400, y: 300, z: 880 },
      }),
    ],
    worktops: [{
      uuid: "worktop-bridge",
      furnitureIDs: ["x-run", "y-run"],
      productInfoDbId: "MAT-WORKTOP",
      thickness: 20,
      altitude: 880,
      parameters: { depth: { value: 635 } },
    }],
  });
}

function projectWith({ furnitures, worktops, plinths = [], linearTypeMap = {}, linearFurnitures = [] }) {
  return {
    core: {
      buildingDocument: {
        buildings: [{
          levels: [{
            furnitures,
          }],
        }],
      },
    },
    linkedStacks: [{
      linkedApps: [{
        data: {
          furnitureToLinearTypeMap: {
            furnitureLinearTypeMap: linearTypeMap,
          },
        },
        linkedDistribs: [{
          data: {
            linears: { worktops, plinths },
          },
        }],
      }],
    }],
    linearFurnitures,
  };
}

function furniture(uuid, dbId, transfo, params, boundingBox) {
  return {
    uuid,
    dbId,
    transfo,
    boundingBox,
    parametersConfig: Object.entries(params).map(([paramID, value]) => ({ paramID, value })),
  };
}

function plinthPathFurniture(uuid) {
  return {
    uuid,
    parametersConfig: [{ paramID: "Default", value: { dbId: "MAT-PLINTH" } }],
    embedResourceInfo: {
      designTree: {
        sketches: [{
          sketch: {
            plane: { O_z: 80 },
            edges: [
              { type: "EdgeLine", gmID: 0, vertices: [{ x: 0, y: 0 }, { x: 500, y: 0 }] },
              { type: "EdgeLine", gmID: 1, vertices: [{ x: 500, y: 0 }, { x: 500, y: 300 }] },
            ],
          },
        }, {
          sketch: {
            plane: { O_z: 0 },
            edges: [
              { type: "EdgeLine", vertices: [{ x: 0, y: -80 }, { x: 10, y: -80 }] },
              { type: "EdgeLine", vertices: [{ x: 10, y: -80 }, { x: 10, y: 0 }] },
              { type: "EdgeLine", vertices: [{ x: 10, y: 0 }, { x: 0, y: 0 }] },
              { type: "EdgeLine", vertices: [{ x: 0, y: 0 }, { x: 0, y: -80 }] },
            ],
          },
        }],
      },
    },
  };
}

function worktopSketchFurniture(uuid) {
  return {
    uuid,
    parametersConfig: [{ paramID: "Default", value: { dbId: "MAT-WORKTOP" } }],
    embedResourceInfo: {
      designTree: {
        sketches: [{
          sketch: {
            edges: [
              { type: "EdgeLine", vertices: [{ x: 4490.959463715553, y: -193.00698718428612 }, { x: 5180.959462597966, y: -193.0069974660873 }] },
              { type: "EdgeLine", vertices: [{ x: 5180.959462597966, y: -193.0069974660873 }, { x: 5180.959462597966, y: 441.99301118510107 }] },
              { type: "EdgeLine", vertices: [{ x: 5180.959462597966, y: 441.99301118510107 }, { x: 4545.959471583366, y: 441.99301199615 }] },
              { type: "EdgeLine", vertices: [{ x: 4545.959471583366, y: 441.99301199615 }, { x: 4490.959473177791, y: 441.9930128157139 }] },
              { type: "EdgeLine", vertices: [{ x: 4490.959473177791, y: 441.9930128157139 }, { x: 4490.959463715553, y: -193.00698718428612 }] },
            ],
          },
        }, {
          sketch: {
            edges: [
              { type: "EdgeLine", vertices: [{ x: 5180.95947265625, y: 1281.9929809570312 }, { x: 4545.95947265625, y: 1281.9929809570312 }] },
              { type: "EdgeLine", vertices: [{ x: 4545.95947265625, y: 1281.9929809570312 }, { x: 4545.959471583366, y: 441.99301199615 }] },
              { type: "EdgeLine", vertices: [{ x: 4545.959471583366, y: 441.99301199615 }, { x: 5180.959462597966, y: 441.99301118510107 }] },
              { type: "EdgeLine", vertices: [{ x: 5180.959462597966, y: 441.99301118510107 }, { x: 5180.95947265625, y: 1281.9929809570312 }] },
            ],
          },
        }],
      },
    },
  };
}

function identityMatrix() {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

function worldRect(slab) {
  const xs = slab.points.map((point) => point[0]);
  const ys = slab.points.map((point) => point[1]);
  return {
    x: { min: Math.min(...xs), max: Math.max(...xs) },
    y: { min: Math.min(...ys), max: Math.max(...ys) },
  };
}

function rectOverlap(a, b) {
  const rectA = worldRect(a);
  const rectB = worldRect(b);
  const x = Math.max(0, Math.min(rectA.x.max, rectB.x.max) - Math.max(rectA.x.min, rectB.x.min));
  const y = Math.max(0, Math.min(rectA.y.max, rectB.y.max) - Math.max(rectA.y.min, rectB.y.min));
  return { x, y, area: x * y };
}

function unionRect(slabs) {
  const rects = slabs.map(worldRect);
  const minX = Math.min(...rects.map((rect) => rect.x.min));
  const maxX = Math.max(...rects.map((rect) => rect.x.max));
  const minY = Math.min(...rects.map((rect) => rect.y.min));
  const maxY = Math.max(...rects.map((rect) => rect.y.max));
  return { minX, maxX, minY, maxY, width: maxX - minX, depth: maxY - minY };
}

function assertNear(actual, expected, message, epsilon = 0.001) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: expected ${expected}, got ${actual}`);
}

function simplePanelObj() {
  return [
    "v 0 0 0",
    "v 1 0 0",
    "v 1 1 0",
    "vt 0 0",
    "vt 1 0",
    "vt 1 1",
    "vn 0 0 1",
    "f 1/1/1 2/2/1 3/3/1",
    "",
  ].join("\n");
}

module.exports = { runSelfTest };
