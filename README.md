# IKEA Planner Assets

Human quick start: provide a public PLATSA or PAX share URL, or an IKEA METHOD planner URL/captured `.BMPROJ`. All three planner types can be exported directly to one OBJ bundle.

Local tooling for assets accessible from IKEA Storage One and METHOD/HomeByMe planner sessions.

## Monorepo layout

- `apps/web`: Bun + Next.js dashboard.
- `packages/cli`: shared `ikea-assets` command-line entry point and OBJ preview renderer.
- `packages/method`: METHOD/HomeByMe capture, BM3 conversion, and kitchen assembly pipeline.
- `packages/storage-one`: shared Storage One downloader with explicit PLATSA and PAX profiles.

Install every workspace from the repository root:

```bash
bun install
```

Run all CLI and dashboard tests with `bun run test:all`. Build the production dashboard with `bun run web:build`.

## PLATSA export

PLATSA uses a DEXF scene graph and direct Draco-compressed GLB product models rather than the kitchen planner's `.BMPROJ`/`.BM3` formats. Export a public design as a single Y-up, metre-based OBJ bundle with:

```bash
node packages/cli/bin/ikea-assets.js platsa-export "https://www.ikea.com/addon-app/storageone/platsa/web/latest/be/en/?vpcSource=clipboard#/vpc/337F9K6" --out assets/platsa --name my-platsa
```

The output directory contains the OBJ, MTL, extracted textures, and an export report describing each placed article, source model, transform, and any skipped geometry. PLATSA product models are already authored in metres; only the planner's millimetre translations are converted during placement.

## PAX export

PAX uses the same Storage One DEXF scene architecture as PLATSA, with its own product catalog and GLB models. Export a public design with the analogous command:

```bash
node packages/cli/bin/ikea-assets.js pax-export "https://www.ikea.com/addon-app/storageone/pax/web/latest/be/en/?vpcSource=clipboard#/vpc/337LMDY" --out assets/pax --name my-pax
```

This writes one Y-up, metre-based OBJ/MTL bundle, extracted textures, captured source JSON, and a `.pax-report.json` containing instance, model, transform, bounds, and warning diagnostics. A bare plan id is also accepted; use `--retail-unit` and `--language` when the defaults (`BE`, `en`) do not match the design.

## Web app

The local Bun + Next.js dashboard wraps `platsa-export`, `pax-export`, and `method-export`. It lists persisted plans in a sidebar, tracks each job, renders a preview when possible, and produces a downloadable ZIP containing the full OBJ bundle.

```bash
bun install
cp apps/web/.env.example apps/web/.env.local
bun run web:dev
```

Open `http://localhost:3000`, select PLATSA, PAX, or METHOD, and paste the matching public planner URL. See [`apps/web/README.md`](apps/web/README.md) for job retention, concurrency, and path configuration.

Completed jobs are stored below `IKEA_PLANNER_EXPORT_WORK_DIR`, with one directory per job containing working files, preview images, and the downloadable OBJ ZIP. The local app configuration currently points this at the ignored `assets/obj/` directory, so generated models are never committed.

## Package interfaces

The CLI uses the same package interfaces available to other workspace code:

```js
const { exportMethodPlan } = require("@ikea-planner-assets/method");
const { exportPaxPlan, exportPlatsaPlan } = require("@ikea-planner-assets/storage-one");
```

METHOD remains an independent HomeByMe implementation. PAX and PLATSA are explicit profiles over the shared Storage One downloader, GLB decoder, material converter, and OBJ exporter.

## METHOD export

METHOD uses the HomeByMe capture formats already supported by this repository. The one-command exporter captures, maps, converts, and assembles a flat Y-up OBJ with materials, textures, worktops, plinths, and an assembly report:

```bash
node packages/cli/bin/ikea-assets.js method-export "<planner-url>" --out assets/method --name my-method-kitchen
```

## METHOD/HomeByMe pipeline

The pipeline is:

```text
capture -> manifest -> download -> inspect/decode -> convert/export
```

Commands:

```bash
bun run test
node packages/cli/bin/ikea-assets.js capture-browser "<planner-url>" --out capture/playwright --save-bodies
node packages/cli/bin/ikea-assets.js inspect capture/playwright/bodies -o capture/playwright/decoded
node packages/cli/bin/ikea-assets.js map-assets capture/playwright/bodies/<project>.BMPROJ capture/playwright/manifest.json --metadata capture/playwright/bodies/<metadata> -o capture/playwright/asset-map.json --tsv capture/playwright/asset-map.tsv
node packages/cli/bin/ikea-assets.js convert capture/playwright/bodies -o assets/exported/live-home-3d --format obj --scale 0.001
node packages/cli/bin/ikea-assets.js name-exports capture/playwright/asset-map.json --obj-dir assets/exported/live-home-3d -o assets/named-obj
node packages/cli/bin/ikea-assets.js assemble capture/playwright/bodies/<project>.BMPROJ capture/playwright/asset-map.json --obj-dir assets/exported/live-home-3d -o assets/assemblies --instance <furniture-uuid-or-dbId>
node packages/cli/bin/ikea-assets.js assemble capture/playwright/bodies/<project>.BMPROJ capture/playwright/asset-map.json --obj-dir assets/exported/live-home-3d -o assets/whole-kitchen --whole --worktops --flat --axis y-up --name ikea-kitchen-livehome-flat-yup
node packages/cli/bin/ikea-assets.js preview assets/whole-kitchen/ikea-kitchen-livehome-flat-yup.obj --mtl assets/whole-kitchen/ikea-kitchen-livehome-flat-yup.mtl -o assets/previews/kitchen
node packages/cli/bin/ikea-assets.js preview assets/whole-kitchen/ikea-kitchen-livehome-flat-yup.obj --mtl assets/whole-kitchen/ikea-kitchen-livehome-flat-yup.mtl -o assets/previews/worktops --only-material procedural_worktop
node packages/cli/bin/ikea-assets.js preview assets/whole-kitchen/ikea-kitchen-livehome-flat-yup.obj --mtl assets/whole-kitchen/ikea-kitchen-livehome-flat-yup.mtl -o assets/previews/plinths --only-material procedural_plinth
node packages/cli/bin/ikea-assets.js convert capture/playwright/bodies -o assets/exported/glb --format glb --scale 0.001
```

If Live Home 3D warns that a whole-kitchen OBJ is too complex, add `--internal-parts omit` to remove hidden cabinet contents, `--proxy-over-faces 1000` for a lighter import, or `--proxy-over-faces 500` for the most import-friendly version. These options keep planner placement, procedural worktops, and sink/hob/tap cutouts while either omitting hidden internals or replacing high-face-count child parts with fitted bounding-box proxies.

The converter understands ByMe `.BM3` ZIP archives and exports them as:

- `OBJ` + `MTL` + texture sidecars for Live Home 3D import.
- `GLB` for normalized glTF workflows and inspection.

Captured `.BMA` files are product/assembly metadata. `.BM3MAT` files are material-only archives and are reported as `bm3-no-geometry`.

`map-assets` correlates opaque CDN downloads with planner/catalog names. It joins CDN `baseURL` UUIDs from `.BMPROJ` `productResourceInfos`, captured `/3/products` catalog responses, and optional project metadata/BOM data. The report keeps both the asset's own label and the placed planner instances that reference it, since a visible cabinet assembly is often made from many child `.BMA` and `.BM3` assets.

`assemble` resolves a placed `.BMA` product into one grouped OBJ by recursively following active child component references and merging already-converted BM3 OBJ files. With `--whole`, it applies each placed furniture transform and exports the whole project as one OBJ. For Live Home 3D whole-kitchen import, prefer `--worktops --flat --axis y-up`; `--worktops` adds procedural countertop slabs from the planner's linear worktop data, textures them from the captured `.BM3MAT` material, subtracts detected sink/hob/tap cutout operation assemblies from the slab mesh, and includes procedural plinth/toe-kick strips from the planner's linear plinth path sketches. You can also request only plinth linears with `--plinths`. `--flat` writes one OBJ object so importers cannot split and re-origin individual parts, and `--axis y-up` converts ByMe's Z-up coordinates to the Y-up convention common in home-design importers. During merge it applies BM3 `scalingAreas` with the child `width`, `depth`, and `height` overloads, which is important for parametric fronts, drawers, rails, shelves, and frames. It preserves MTL materials, including embedded BM3 texture maps when present, and copies texture sidecars into the output folder. `--internal-parts proxy|omit` detects hidden cabinet contents such as drawer boxes, bins, internal shelves, pull-out fittings, and integrated appliances, then either replaces them with fitted proxies or removes them from the written OBJ. The assembly report includes planner-space placement matrices, component fit diagnostics, detected operation cutouts, procedural worktop and plinth diagnostics, hidden/internal part decisions, proxy substitutions, and world bounding boxes for debugging. This is a practical Live Home 3D handoff, but it is not yet a pixel-perfect planner export: rounded sink/hob corners and circular tap holes are currently approximated as rectangular openings.

`name-exports` copies converted OBJ bundles to suggestive filenames using catalog labels from `asset-map.json`. It rewrites each OBJ's `mtllib` reference and copies texture sidecars so the named files remain self-contained for import.

`preview` renders fixed-angle PNG screenshots and a `.preview-report.json` for any OBJ/MTL bundle using Three.js and Playwright. Use `--only-material procedural_worktop` to isolate countertop geometry before importing a candidate into Live Home 3D.

`npm test` runs smoke tests for request import/asset inspection plus synthetic assembly regressions for procedural worktop corner bridges, freestanding filler corner alignment, wall-side countertop edge extension, and procedural plinth path export.

See [docs/FORMAT_NOTES.md](docs/FORMAT_NOTES.md) for current reverse-engineering notes.
