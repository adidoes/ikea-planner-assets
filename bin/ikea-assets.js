#!/usr/bin/env node
"use strict";

const { Command } = require("commander");
const { captureBrowser } = require("../src/capture-browser");
const { importRequests } = require("../src/import-requests");
const { downloadManifest } = require("../src/download");
const { inspectInputs } = require("../src/inspect");
const { assembleInputs } = require("../src/assemble");
const { convertInputs } = require("../src/convert");
const { indexBundles } = require("../src/index-bundles");
const { mapAssets } = require("../src/map-assets");
const { nameExports } = require("../src/name-exports");
const { previewObj } = require("../src/preview");
const { runSelfTest } = require("../src/self-test");

const program = new Command();

program
  .name("ikea-assets")
  .description("Capture and convert accessible IKEA/HomeByMe planner assets.")
  .version("0.1.0");

program
  .command("capture-browser")
  .description("Open a planner URL with Playwright and capture all observed network traffic.")
  .argument("[url]", "Planner URL", "https://kitchen.planner.ikea.com/be/en/planner/296A373C-D0E2-4BDB-B7CC-B69FF4441452/")
  .option("-o, --out <dir>", "Output directory", "capture/playwright")
  .option("--wait-ms <ms>", "Extra wait after network idle", parseInteger, 25000)
  .option("--headed", "Show the browser window")
  .option("--save-bodies", "Save response bodies for candidate asset URLs")
  .option("--candidate <regex>", "Regex used to decide which response bodies to save")
  .option("--user-agent <ua>", "Override browser user agent")
  .action(async (url, options) => captureBrowser(url, options));

program
  .command("import-requests")
  .description("Import URLs from agent-browser network JSON, HAR, cURL, or a plain URL list into a manifest.")
  .argument("<input>", "Input file")
  .option("-o, --out <file>", "Manifest path", "capture/manifest.json")
  .option("--include <regex>", "Only include matching URLs")
  .option("--exclude <regex>", "Exclude matching URLs")
  .action(async (input, options) => importRequests(input, options));

program
  .command("download")
  .description("Download every asset listed in a manifest.")
  .argument("<manifest>", "Manifest JSON")
  .option("-o, --out <dir>", "Raw asset directory", "assets/raw")
  .option("--concurrency <n>", "Parallel downloads", parseInteger, 6)
  .option("--referer <url>", "Referer header to send")
  .option("--user-agent <ua>", "User-Agent header to send")
  .action(async (manifest, options) => downloadManifest(manifest, options));

program
  .command("inspect")
  .description("Inspect raw assets, decode known compression, and write an analysis manifest.")
  .argument("[inputs...]", "Files or directories to inspect", ["assets/raw"])
  .option("-o, --out <dir>", "Decoded/analysis directory", "assets/decoded")
  .option("--write-decoded", "Write decoded Brotli/Gzip/JSON payloads when possible", true)
  .action(async (inputs, options) => inspectInputs(inputs, options));

program
  .command("index-bundles")
  .description("Extract useful URL/extension/loader hints from downloaded planner JS bundles.")
  .argument("[inputs...]", "Bundle files or directories", ["capture/bundles"])
  .option("-o, --out <file>", "Index JSON path", "capture/meta/bundle-index.json")
  .action(async (inputs, options) => indexBundles(inputs, options));

program
  .command("convert")
  .description("Convert supported model assets to GLB/OBJ/DAE-friendly exports.")
  .argument("[inputs...]", "Files or directories to convert", ["assets/decoded", "assets/raw"])
  .option("-o, --out <dir>", "Export directory", "assets/exported")
  .option("--format <format>", "Target format: glb, obj, dae, or all", "glb")
  .option("--scale <n>", "Root scale applied to ByMe millimeter assets", Number.parseFloat, 0.001)
  .action(async (inputs, options) => convertInputs(inputs, options));

program
  .command("assemble")
  .description("Compose a placed .BMA assembly into one grouped OBJ using already-converted child BM3 OBJ files.")
  .argument("<bmproj>", "Captured .BMPROJ project file")
  .argument("<assetMap>", "Asset map JSON from map-assets")
  .requiredOption("--obj-dir <dir>", "Directory containing converted child OBJ files")
  .option("-o, --out <dir>", "Assembly export directory", "assets/assemblies")
  .option("--instance <uuidOrDbId>", "Furniture uuid or dbId to assemble; defaults to the first placed furniture")
  .option("--whole", "Assemble every placed furniture item into one whole-project OBJ")
  .option("--worktops", "Include procedural worktop/countertop slabs from planner linear worktop data")
  .option("--flat", "Write one flat OBJ object without per-part o/g records")
  .option("--proxy-over-faces <n>", "Replace child OBJ parts above this face count with lightweight bounding-box proxies", parseInteger)
  .option("--internal-parts <mode>", "How to handle hidden/internal cabinet parts: keep, proxy, or omit", "keep")
  .option("--axis <axis>", "Output axis convention: z-up or y-up", "z-up")
  .option("--name <name>", "Output basename for --whole", "Complete kitchen")
  .option("--scale <n>", "Unit scale from ByMe millimeters to target units", Number.parseFloat, 0.001)
  .action(async (bmproj, assetMap, options) => assembleInputs(bmproj, assetMap, options));

program
  .command("name-exports")
  .description("Copy converted OBJ bundles to suggestive filenames using asset-map catalog labels.")
  .argument("<assetMap>", "Asset map JSON from map-assets")
  .requiredOption("--obj-dir <dir>", "Directory containing converted OBJ/MTL/texture files")
  .option("-o, --out <dir>", "Named OBJ bundle directory", "assets/named-obj")
  .action(async (assetMap, options) => nameExports(assetMap, options));

program
  .command("preview")
  .description("Render fixed-angle PNG previews for an OBJ/MTL bundle with Three.js and Playwright.")
  .argument("<obj>", "OBJ file to preview")
  .requiredOption("--mtl <file>", "MTL file to load with the OBJ")
  .option("-o, --out <dir>", "Preview output directory", "assets/previews")
  .option("--width <px>", "Screenshot width", parseInteger, 1400)
  .option("--height <px>", "Screenshot height", parseInteger, 1000)
  .option("--only-material <regex>", "Only show meshes whose material name matches this regex")
  .option("--angles <names>", "Comma-separated angles: iso,front,back,left,right,top,low", "iso,front,right,left,top")
  .action(async (obj, options) => previewObj(obj, options));

program
  .command("map-assets")
  .description("Join downloaded CDN assets to planner product IDs, catalog names, and project instances.")
  .argument("<bmproj>", "Captured .BMPROJ project file")
  .argument("<manifest>", "Capture manifest JSON")
  .option("-o, --out <file>", "Asset map JSON path", "capture/asset-map.json")
  .option("--tsv <file>", "Optional tab-separated report path")
  .option("--metadata <file>", "Optional captured project metadata response with appData.bom")
  .option("--products <files...>", "Optional captured /3/products JSON response files")
  .action(async (bmproj, manifest, options) => mapAssets(bmproj, manifest, options));

program
  .command("self-test")
  .description("Run local smoke tests for manifest import, decoding, and conversion fallbacks.")
  .action(async () => runSelfTest());

function parseInteger(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected an integer, got ${value}`);
  }
  return parsed;
}

program.parseAsync().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
