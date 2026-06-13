"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { ensureDir, writeJson } = require("./common");

async function previewObj(objPath, options) {
  const objAbs = path.resolve(objPath);
  const mtlAbs = path.resolve(options.mtl);
  const outDir = path.resolve(options.out || "assets/previews");
  const width = Number.isFinite(options.width) ? options.width : 1400;
  const height = Number.isFinite(options.height) ? options.height : 1000;
  const angles = String(options.angles || "iso,front,right,left,top")
    .split(",")
    .map((angle) => angle.trim())
    .filter(Boolean);

  await ensureDir(outDir);
  const server = await createPreviewServer({
    rootDir: path.dirname(objAbs),
    objName: path.basename(objAbs),
    mtlName: path.basename(mtlAbs),
    onlyMaterial: options.onlyMaterial || "",
  });

  const browser = await chromium.launch({ headless: true });
  const screenshots = [];
  let report = null;
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(`${server.url}/viewer`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__previewReady === true, null, { timeout: 120000 });
    report = await page.evaluate(() => window.__previewReport);
    for (const angle of angles) {
      await page.evaluate((name) => window.__setPreviewCamera(name), angle);
      await page.waitForTimeout(150);
      const file = path.join(outDir, `${sanitizePreviewName(path.basename(objAbs, ".obj"))}-${angle}${options.onlyMaterial ? "-filtered" : ""}.png`);
      await page.screenshot({ path: file });
      screenshots.push(file);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const outputReport = {
    schema: "ikea-planner-assets.preview.v1",
    generatedAt: new Date().toISOString(),
    input: {
      obj: objAbs,
      mtl: mtlAbs,
      onlyMaterial: options.onlyMaterial || null,
      angles,
      viewport: { width, height },
    },
    scene: report,
    screenshots,
  };
  const reportPath = path.join(outDir, `${sanitizePreviewName(path.basename(objAbs, ".obj"))}${options.onlyMaterial ? "-filtered" : ""}.preview-report.json`);
  await writeJson(reportPath, outputReport);
  console.log(`Rendered ${screenshots.length} preview screenshot(s); wrote ${reportPath}`);
  return outputReport;
}

async function createPreviewServer(config) {
  const rootDir = config.rootDir;
  const html = viewerHtml(config);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/viewer") {
        send(res, 200, "text/html; charset=utf-8", html);
        return;
      }
      if (url.pathname.startsWith("/asset/")) {
        const rel = decodeURIComponent(url.pathname.slice("/asset/".length));
        const abs = path.resolve(rootDir, rel);
        if (!abs.startsWith(`${rootDir}${path.sep}`) && abs !== rootDir) {
          send(res, 403, "text/plain", "Forbidden");
          return;
        }
        const data = await fs.readFile(abs);
        send(res, 200, contentType(abs), data);
        return;
      }
      if (url.pathname.startsWith("/node_modules/")) {
        const abs = path.resolve(process.cwd(), `.${url.pathname}`);
        const nodeModules = path.resolve(process.cwd(), "node_modules");
        if (!abs.startsWith(`${nodeModules}${path.sep}`)) {
          send(res, 403, "text/plain", "Forbidden");
          return;
        }
        const data = await fs.readFile(abs);
        send(res, 200, contentType(abs), data);
        return;
      }
      send(res, 404, "text/plain", "Not found");
    } catch (error) {
      send(res, 500, "text/plain", error.stack || error.message || String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function viewerHtml(config) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>IKEA OBJ Preview</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #e7e7e2; }
    canvas { display: block; }
  </style>
  <script type="importmap">
  {
    "imports": {
      "three": "/node_modules/three/build/three.module.js",
      "three/addons/": "/node_modules/three/examples/jsm/"
    }
  }
  </script>
</head>
<body>
<script type="module">
import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe7e7e2);
scene.add(new THREE.HemisphereLight(0xffffff, 0x999999, 2.2));
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(3, 5, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.8);
fill.position.set(-4, 2, -3);
scene.add(fill);

const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.01, 200);
const root = new THREE.Group();
scene.add(root);

const onlyMaterial = ${JSON.stringify(config.onlyMaterial || "")};
const onlyMaterialRe = onlyMaterial ? new RegExp(onlyMaterial, "i") : null;
const materialNames = new Map();

const mtlLoader = new MTLLoader();
mtlLoader.setPath("/asset/");
mtlLoader.setResourcePath("/asset/");
const materials = await mtlLoader.loadAsync(${JSON.stringify(config.mtlName)});
materials.preload();

const objLoader = new OBJLoader();
objLoader.setPath("/asset/");
objLoader.setMaterials(materials);
const loaded = await objLoader.loadAsync(${JSON.stringify(config.objName)});
root.add(loaded);

let meshCount = 0;
let visibleMeshCount = 0;
let selectedGroupCount = 0;
loaded.traverse((node) => {
  if (!node.isMesh) return;
  meshCount++;
  const mats = Array.isArray(node.material) ? node.material : [node.material];
  for (const mat of mats) materialNames.set(mat?.name || "(unnamed)", true);
  const selectedGroups = selectedMaterialGroups(node, onlyMaterialRe);
  if (!selectedGroups.length) {
    node.visible = false;
  } else {
    node.userData.previewGroups = selectedGroups;
    if (onlyMaterialRe && Array.isArray(node.material)) {
      node.geometry.clearGroups();
      for (const group of selectedGroups) node.geometry.addGroup(group.start, group.count, group.materialIndex);
    }
    selectedGroupCount += selectedGroups.length;
    visibleMeshCount++;
  }
  if (node.material) {
    for (const mat of mats) {
      if (!mat) continue;
      mat.side = THREE.FrontSide;
      if (mat.map) {
        mat.map.colorSpace = THREE.SRGBColorSpace;
        mat.map.anisotropy = 8;
      }
    }
  }
});

root.updateMatrixWorld(true);
const finiteBounds = computeFiniteBounds(root);
const center = finiteBounds.center;
const size = finiteBounds.size;
const radius = Math.max(size.x, size.y, size.z) || 1;
root.position.sub(center);

const grid = new THREE.GridHelper(Math.max(2, radius * 1.2), 20, 0x888888, 0xc8c8c8);
grid.position.y = -size.y / 2 - Math.max(0.04, radius * 0.015);
scene.add(grid);

function render() {
  renderer.render(scene, camera);
}

window.__setPreviewCamera = (name) => {
  const distance = Math.max(2, radius * 1.25);
  const positions = {
    iso: [distance, distance * 0.65, distance],
    front: [0, distance * 0.25, distance],
    back: [0, distance * 0.25, -distance],
    left: [-distance, distance * 0.25, 0],
    right: [distance, distance * 0.25, 0],
    top: [0, distance, 0.001],
    low: [distance, distance * 0.18, distance * 0.45],
  };
  const p = positions[name] || positions.iso;
  camera.position.set(p[0], p[1], p[2]);
  camera.near = Math.max(0.001, distance / 500);
  camera.far = distance * 8;
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  render();
};

window.__previewReport = {
  meshCount,
  visibleMeshCount,
  selectedGroupCount,
  materialNames: Array.from(materialNames.keys()).sort(),
  bounds: {
    min: finiteBounds.min.toArray(),
    max: finiteBounds.max.toArray(),
    size: size.toArray(),
  },
};
window.__setPreviewCamera("iso");
window.__previewReady = true;

function selectedMaterialGroups(mesh, regex) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const groups = mesh.geometry.groups?.length
    ? mesh.geometry.groups
    : [{ start: 0, count: drawCount(mesh.geometry), materialIndex: 0 }];
  if (!regex) return groups.slice();
  return groups.filter((group) => regex.test(materials[group.materialIndex]?.name || ""));
}

function drawCount(geometry) {
  return geometry.index ? geometry.index.count : geometry.getAttribute("position")?.count || 0;
}

function computeFiniteBounds(object) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const point = new THREE.Vector3();
  let count = 0;
  object.traverse((node) => {
    if (!node.isMesh || !node.visible) return;
    const position = node.geometry.getAttribute("position");
    if (!position) return;
    const index = node.geometry.index;
    const groups = node.userData.previewGroups?.length
      ? node.userData.previewGroups
      : [{ start: 0, count: drawCount(node.geometry), materialIndex: 0 }];
    for (const group of groups) {
      const end = Math.min(group.start + group.count, index ? index.count : position.count);
      for (let i = group.start; i < end; i++) {
        const vertexIndex = index ? index.getX(i) : i;
        point.fromBufferAttribute(position, vertexIndex).applyMatrix4(node.matrixWorld);
        if (![point.x, point.y, point.z].every(Number.isFinite)) continue;
        min.min(point);
        max.max(point);
        count++;
      }
    }
  });
  if (!count) {
    min.set(-1, -1, -1);
    max.set(1, 1, 1);
  }
  return {
    min,
    max,
    center: new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5),
    size: new THREE.Vector3().subVectors(max, min),
    finiteVertexCount: count,
  };
}
</script>
</body>
</html>`;
}

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".js") return "text/javascript";
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".obj" || ext === ".mtl" || ext === ".txt") return "text/plain; charset=utf-8";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function sanitizePreviewName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "preview";
}

module.exports = { previewObj };
