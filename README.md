# IKEA Planner Assets

Human quick start: ask an agent to run this repo against your IKEA kitchen planner URL or captured `.BMPROJ` plus manifest/metadata, then use `capture/<run>/asset-map.tsv` for object-name mapping and the OBJ/MTL bundles in your chosen output folder, usually `assets/named-obj/` or `assets/whole-kitchen/`, importing whole kitchens into Live Home 3D as meters with Y-up.

Local tooling for assets already accessible from an IKEA/HomeByMe kitchen planner session.

The pipeline is:

```text
capture -> manifest -> download -> inspect/decode -> convert/export
```

Commands:

```bash
npm run test
node bin/ikea-assets.js capture-browser "<planner-url>" --out capture/playwright --save-bodies
node bin/ikea-assets.js inspect capture/playwright/bodies -o capture/playwright/decoded
node bin/ikea-assets.js map-assets capture/playwright/bodies/<project>.BMPROJ capture/playwright/manifest.json --metadata capture/playwright/bodies/<metadata> -o capture/playwright/asset-map.json --tsv capture/playwright/asset-map.tsv
node bin/ikea-assets.js convert capture/playwright/bodies -o assets/exported/live-home-3d --format obj --scale 0.001
node bin/ikea-assets.js name-exports capture/playwright/asset-map.json --obj-dir assets/exported/live-home-3d -o assets/named-obj
node bin/ikea-assets.js assemble capture/playwright/bodies/<project>.BMPROJ capture/playwright/asset-map.json --obj-dir assets/exported/live-home-3d -o assets/assemblies --instance <furniture-uuid-or-dbId>
node bin/ikea-assets.js assemble capture/playwright/bodies/<project>.BMPROJ capture/playwright/asset-map.json --obj-dir assets/exported/live-home-3d -o assets/whole-kitchen --whole --worktops --flat --axis y-up --name ikea-kitchen-livehome-flat-yup
node bin/ikea-assets.js preview assets/whole-kitchen/ikea-kitchen-livehome-flat-yup.obj --mtl assets/whole-kitchen/ikea-kitchen-livehome-flat-yup.mtl -o assets/previews/kitchen
node bin/ikea-assets.js preview assets/whole-kitchen/ikea-kitchen-livehome-flat-yup.obj --mtl assets/whole-kitchen/ikea-kitchen-livehome-flat-yup.mtl -o assets/previews/worktops --only-material procedural_worktop
node bin/ikea-assets.js preview assets/whole-kitchen/ikea-kitchen-livehome-flat-yup.obj --mtl assets/whole-kitchen/ikea-kitchen-livehome-flat-yup.mtl -o assets/previews/plinths --only-material procedural_plinth
node bin/ikea-assets.js convert capture/playwright/bodies -o assets/exported/glb --format glb --scale 0.001
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
