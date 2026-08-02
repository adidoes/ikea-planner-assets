"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  buildWorktopGeometry,
  decodeWorktopConfiguration,
  exportWorktopPlan,
  footprintsForShape,
  parseWorktopReference,
  triangulatePolygon,
} = require(".");

async function runSelfTest() {
  const fixturePath = path.join(__dirname, "..", "test", "fixtures", "live-l-shape-337M78D.json");
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const short = parseWorktopReference(fixture._fixture.publicUrl);
  assert.deepEqual({ code: short.code, country: short.country, language: short.language }, { code: "337M78D", country: "BE", language: "en" });
  const deep = parseWorktopReference("https://www.ikea.com/addon-app/cwcalc/irw/latest/be/en/#/?code=337M78D");
  assert.equal(deep.code, "337M78D");
  assert.throws(() => parseWorktopReference("337M78D"), /requires options.country/);
  assert.equal(parseWorktopReference("337M78D", { country: "be", language: "en" }).locale, "en-BE");

  const plan = decodeWorktopConfiguration(fixture);
  const geometry = buildWorktopGeometry(plan);
  assert.equal(plan.main.shape, "l-shape");
  assert.equal(geometry.segments.length, 1);
  assert.equal(geometry.segments[0].areaMm2, 3_406_775);
  assert.deepEqual(geometry.boundsMm, { min: [0, 0, 0], max: [3000, 3000, 28] });
  assert.equal(triangulatePolygon(geometry.segments[0].polygonMm).length, 4);

  const shapeCases = [
    ["rectangular", { a: 1000, b: 635 }, 1],
    ["u-shape", { a: 3000, b: 3000, c: 3000, d: 635, e: 635, f: 635 }, 1],
    ["v-shape", { a: 3000, b: 3000 }, 1],
    ["c-shape", { a: 3000, b: 3000 }, 1],
    ["ii-shape", { a: 3000, b: 635, c: 2500, d: 700 }, 2],
    ["irregular", { a: 3000, b: 635, c: 800 }, 1],
    ["g-shape", { a: 3000, b: 3000, c: 2000, d: 2000, e: 635, f: 635, g: 635, h: 635 }, 1],
  ];
  for (const [shape, dimensions, count] of shapeCases) {
    const footprints = footprintsForShape(shape, dimensions, { separateGapMm: 500 });
    assert.equal(footprints.length, count, shape);
    for (const footprint of footprints) assert.equal(triangulatePolygon(footprint.points).length, footprint.points.length - 2, shape);
  }

  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ikea-worktop-test-"));
  try {
    const exported = await exportWorktopPlan(fixture, { out: outputRoot, country: "BE", language: "en", name: "live-l-shape" });
    const [obj, mtl, report] = await Promise.all([
      fs.readFile(exported.objPath, "utf8"),
      fs.readFile(exported.mtlPath, "utf8"),
      fs.readFile(exported.reportPath, "utf8").then(JSON.parse),
    ]);
    assert.match(obj, /^# IKEA Custom Worktop Calculator export/m);
    assert.match(obj, /^f /m);
    assert.match(mtl, /^newmtl worktop_main_laminate_whitelaminate/m);
    assert.equal(report.summary.faces, 20);
    assert.equal(report.outputs.textures.length, 0);

    let request;
    const fetched = await exportWorktopPlan(fixture._fixture.publicUrl, {
      out: path.join(outputRoot, "fetch"),
      fetch: async (url, init) => {
        request = { url, init };
        return { ok: true, status: 200, json: async () => fixture };
      },
    });
    assert.match(request.url, /retailunit\/BE\/locale\/en-BE\/337M78D$/);
    assert.ok(request.init.headers["DEXF-API-KEY"]);
    assert.equal(fetched.report.source.country, "BE");

    const withCutout = structuredClone(fixture);
    withCutout.configuration.content.parameters.find((entry) => entry.name === "cutout").value = "2";
    const cutoutExport = await exportWorktopPlan(withCutout, { out: path.join(outputRoot, "cutout") });
    assert.equal(cutoutExport.report.operations.unresolved[0].count, 2);
    assert.equal(cutoutExport.report.operations.applied.length, 0);

    if (process.env.IKEA_WORKTOP_LIVE === "1") {
      const live = await exportWorktopPlan(fixture._fixture.publicUrl, { out: path.join(outputRoot, "live") });
      assert.equal(live.report.source.configurationId, fixture._fixture.configurationId);
    }
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
  console.log("worktop self-test ok");
}

if (require.main === module) {
  runSelfTest().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runSelfTest };
