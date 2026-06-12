# Agent Notes

This repo is a local pipeline for capturing IKEA/HomeByMe kitchen planner assets, converting captured `.BM3` geometry to normal 3D formats, and assembling planner furniture/whole kitchens into OBJ bundles that can be imported into Live Home 3D.

## What To Ask The User For

Ask for one of these inputs:

- A live IKEA kitchen planner URL, preferably already opened and loaded in the in-app browser.
- Or an existing captured project set: a `.BMPROJ`, `manifest.json`, optional metadata/products responses, and an `asset-map.json`.

If the goal is Live Home 3D, ask whether they want:

- Individual named asset OBJ bundles.
- One whole-kitchen OBJ.
- A lighter whole-kitchen OBJ using proxy boxes for high-detail parts.

## Main Commands

Run checks first when changing code:

```bash
npm test
```

Capture a loaded planner session:

```bash
node bin/ikea-assets.js capture-browser "<planner-url>" --out capture/playwright --save-bodies
```

Build the asset/name map:

```bash
node bin/ikea-assets.js map-assets capture/playwright/bodies/<project>.BMPROJ capture/playwright/manifest.json --metadata capture/playwright/bodies/<metadata> -o capture/playwright/asset-map.json --tsv capture/playwright/asset-map.tsv
```

Convert captured `.BM3` files:

```bash
node bin/ikea-assets.js convert capture/playwright/bodies -o assets/exported/live-home-3d --format obj --scale 0.001
```

Create suggestive filenames:

```bash
node bin/ikea-assets.js name-exports capture/playwright/asset-map.json --obj-dir assets/exported/live-home-3d -o assets/named-obj
```

Assemble one placed furniture item:

```bash
node bin/ikea-assets.js assemble capture/playwright/bodies/<project>.BMPROJ capture/playwright/asset-map.json --obj-dir assets/exported/live-home-3d -o assets/assemblies --instance <furniture-uuid-or-dbId>
```

Assemble the whole kitchen for Live Home 3D:

```bash
node bin/ikea-assets.js assemble capture/playwright/bodies/<project>.BMPROJ capture/playwright/asset-map.json --obj-dir assets/exported/live-home-3d -o assets/whole-kitchen --whole --worktops --flat --axis y-up --name ikea-kitchen-livehome-flat-yup
```

If Live Home 3D warns that the OBJ is too complex, add a proxy threshold:

```bash
node bin/ikea-assets.js assemble capture/playwright/bodies/<project>.BMPROJ capture/playwright/asset-map.json --obj-dir assets/exported/live-home-3d -o assets/whole-kitchen --whole --worktops --flat --axis y-up --proxy-over-faces 500 --name ikea-kitchen-livehome-flat-yup-lite
```

## Important Outputs

- `capture/<run>/asset-map.tsv`: human-readable correlation between opaque CDN files and planner/catalog names.
- `assets/named-obj/`: individual OBJ/MTL/texture bundles copied to suggestive filenames.
- `assets/assemblies/`: single placed furniture assemblies.
- `assets/whole-kitchen/`: whole-kitchen OBJ/MTL bundles and `.assembly-report.json`.
- `.assembly-report.json`: diagnostics for placements, resolved leaves, procedural worktops, cutout operations, fitted scaling areas, skipped references, and proxy substitutions.

Do not commit `capture/`, `assets/`, `node_modules/`, generated OBJ/MTL files, HARs, or planner screenshots. They are local artifacts and can be very large.

## How The Pipeline Works

`capture-browser` uses Playwright to load the planner, record network traffic, and optionally save response bodies for candidate assets.

`map-assets` joins several sources of truth:

- `.BMPROJ` `productResourceInfos`, which bind planner product IDs to CDN `baseURL` UUIDs.
- The capture manifest, which records downloaded CDN URLs and local filenames.
- Optional `/3/products` catalog responses, which provide human labels and product metadata.
- Optional project metadata/BOM responses, which expose bill-of-material lines and worktop custom-piece data.

`convert` decodes ByMe `.BM3` ZIP archives and exports geometry as OBJ/MTL or GLB. `.BMA` files are assembly metadata, not mesh geometry. `.BM3MAT` files are material-only archives.

`assemble` recursively resolves active `.BMA` components. It evaluates relations/overloads, follows child product references, applies nested transforms, and merges converted child BM3 OBJ files. For `--whole`, it starts from every placed furniture item in the project and applies the planner placement matrix for each item.

For parametric cabinet parts, `assemble` reads BM3 `scalingAreas` and fits source geometry to the resolved child `width`, `depth`, and `height` parameters. This is what keeps fronts, drawers, shelves, frames, and rails aligned instead of leaving them at default catalog sizes.

With `--worktops`, `assemble` reads planner linear worktop data and generates procedural slab meshes. It extracts the captured `.BM3MAT` worktop texture, adds it to the MTL, and detects sink/hob/tap cutout operation assemblies. Those cutouts are assigned to the matching slab and subtracted by tessellating the slab top/bottom plus vertical opening walls.

With `--proxy-over-faces <n>`, `assemble` counts each child source OBJ. If a leaf exceeds the threshold, it replaces that leaf with a fitted bounding-box proxy materialized at the same transform. This keeps Live Home 3D imports manageable while preserving overall placement and dimensions.

## Live Home 3D Import

For whole-kitchen exports made with `--axis y-up --scale 0.001`, use:

- Model Units: `Meters`
- Up Axis: `Y`
- Split object instances: off if Live Home allows it
- Level of detail: lower it if Live Home warns about complexity

If the normal whole-kitchen OBJ is too heavy, regenerate with `--proxy-over-faces 1000` or `--proxy-over-faces 500`.

## Implementation Map

- `bin/ikea-assets.js`: CLI command definitions.
- `src/capture-browser.js`: Playwright capture.
- `src/map-assets.js`: asset/catalog/project correlation.
- `src/convert.js`: BM3/BM3MAT conversion and export.
- `src/name-exports.js`: suggestive OBJ bundle naming.
- `src/assemble.js`: assembly resolver, scaling-area fitting, worktop generation, cutouts, and proxy export.
- `docs/FORMAT_NOTES.md`: reverse-engineering notes.

## Verification

Use:

```bash
node --check src/assemble.js
npm test
```

For generated OBJ bundles, also check `.assembly-report.json` summaries, texture map existence in the MTL, and final OBJ counts (`v`, `vt`, `vn`, `f`) when Live Home 3D performance matters.
