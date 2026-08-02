# Agent Notes

This monorepo exports accessible saved IKEA planner designs into portable OBJ bundles. Do not assume every IKEA planning experience uses the same runtime: route work through the planner registry and the family adapter that owns the saved format.

`packages/planner-registry` is the source of truth for planner slugs, families, CLI command names, aliases, and CLI/web routing. It contains 38 exportable entries: 15 Storage One, 13 IKEA Space, six sofa ranges, ENHET, METHOD, SKYTTA, and Custom Worktop.

## Exportability Boundary

An exportable input must expose a durable saved design containing placed 3D entities, transforms, and resolvable model or procedural geometry data.

The **Appliance guide**, **Storage guide**, **Mattress guide**, and **Sofa navigator** are not exportable. They are discovery/advice tools and do not expose a public saved 3D design. Do not fabricate an arrangement from a guide's product list and do not add these tools to the registry. If one launches a supported planner, ask for the resulting planner share link.

**IKEA Kreativ** is a different case: it has its own scene pipeline, but that pipeline is not implemented in this repository. Keep it out of the registry and do not route it through the Space adapter.

Private/account-only plans are also outside the public retrieval paths unless the user provides an authorized, in-scope capture.

## What To Ask The User For

Ask for:

- The exact planner family and a public IKEA share URL. Prefer the full URL because it carries the range and locale.
- For CLI use with a bare code: the retail unit and language if they are not `BE`/`en`.
- The desired output axis/importer. High-level exporters default to Y-up metres, suitable for Live Home 3D.
- Whether the user needs a normal or lighter METHOD kitchen, and whether hidden cabinet internals may be omitted.

Family-specific alternatives:

- METHOD: a loaded planner URL, or an existing `.BMPROJ`, `manifest.json`, optional metadata/product responses, and `asset-map.json`.
- Custom Worktop: a CWCALC saved link/code or configuration payload; explain that the public payload lacks cut-out positions, room placement, and seamless textures.
- Sofa: a saved design hash/code. An SPR product page alone is not a placed design; ask the user to share it from the sofa planner first.
- SKYTTA: a public `designCode` URL/code. Multi-asset variants that cannot be tied to a placed rail/panel are skipped rather than guessed.

The web dashboard accepts complete public HTTPS IKEA URLs, not bare codes.

## Planner Routing

| Family | Registered planners | Package / command | Main report |
| --- | --- | --- | --- |
| Storage One | BESTÅ, BILLY, BOAXEL, BROR, EKET, ELVARLI, IVAR, JONAXEL, KALLAX, KNOXHULT, LÅDMAKARE, LASTARE, PAX, PLATSA, SMÅSTAD | `packages/storage-one`; `<slug>-export` | `.<slug>-report.json` |
| Space | Outdoor, Bathroom, Dining room, Hallway, Children's room, Bedroom, Living room, Home office, Dining chair/table/set, Desk, MITTZON | `packages/space`; `<slug>-export` | `.space-report.json` |
| Sofas | JÄTTEBO, KIVIK, VIMLE, UPPÅKRA, SÖDERHAMN, LILLEHEM | `packages/sofas`; `<slug>-export` | `.sofa-report.json` |
| ENHET | ENHET | `packages/enhet`; `enhet-export` | `.enhet-report.json` |
| METHOD | METHOD | `packages/method`; `method-export` | `.assembly-report.json` |
| SKYTTA | SKYTTA | `packages/skytta`; `skytta-export` | `.skytta-report.json` |
| Worktop | Custom Worktop Calculator | `packages/worktop`; `worktop-export` | `.worktop-report.json` |

## Standard Workflow

Before changing code, run:

```bash
npm test
```

If the registry, CLI, or dashboard is involved, also run:

```bash
bun run web:test
bun run web:build
```

For an export request:

1. Identify the planner from the URL and confirm it exists in `packages/planner-registry`.
2. Run the registered high-level command with a dedicated output directory.
3. Read the family report before claiming completeness; warnings and skipped entities are part of the result.
4. Confirm OBJ/MTL/texture paths and face counts.
5. Render a preview before asking the user to import the model.

Representative commands:

```bash
node packages/cli/bin/ikea-assets.js platsa-export "<public-share-url-or-code>" --out assets/platsa --name my-platsa
node packages/cli/bin/ikea-assets.js living-room-export "<public-share-url-or-code>" --out assets/living-room
node packages/cli/bin/ikea-assets.js jattebo-export "<public-share-url-or-code>" --out assets/jattebo
node packages/cli/bin/ikea-assets.js enhet-export "<public-share-url-or-code>" --out assets/enhet
node packages/cli/bin/ikea-assets.js method-export "<loaded-planner-url>" --out assets/method --name my-method-kitchen
node packages/cli/bin/ikea-assets.js skytta-export "<public-share-url-or-code>" --out assets/skytta
node packages/cli/bin/ikea-assets.js worktop-export "<public-share-url-or-code>" --out assets/worktop
```

Preview any OBJ/MTL bundle with:

```bash
node packages/cli/bin/ikea-assets.js preview assets/<planner>/<candidate>.obj --mtl assets/<planner>/<candidate>.mtl -o assets/previews/<candidate>
```

## Family Pipelines And Caveats

### Shared DEXF/GLB exporters

Storage One, Space, sofas, ENHET, and SKYTTA resolve public saved entities to product GLBs. Planner translations and catalog model offsets are in millimetres; GLB geometry is authored in metres. The shared exporter performs that placement conversion and writes Y-up by default.

Always check:

- The report's placed/exported/skipped counts and world bounds.
- Each model URL/download record and any variant-selection reason.
- `map_Kd` targets for embedded base-colour textures.
- Warnings for missing models, catalog containers, unsupported primitive modes, and external-only textures.

OBJ/MTL preserves useful base colour, embedded texture, opacity, and approximate surface parameters, not the complete glTF PBR material model. Compatibility GLBs are the default for Storage One and Space; optimized variants can require Draco/WebP support.

Space resolves a saved plan's range IDs against each range's current `/latest/` catalog, because the plan does not expose immutable catalog URLs. Room geometry and catalog-only assembly containers are omitted.

Sofa exports include mesh-bearing saved modules and intentionally omit room/connector helpers. Bare public hash codes remain valid even when the identifier contains `S`; only explicit standalone SPR product references are rejected as non-designs.

SKYTTA exports mesh-backed rails, frames, and panels. BOM-only fittings and room geometry are not modeled. A product with multiple GLB assets is exported only when the placed entity identifies the variant; do not guess. The planner runtime can use a byte-identical CDN alias instead of the Webplanner URL, so compare report hashes as well as URLs.

### Custom Worktop

`packages/worktop` decodes CWCALC dimensions and generates triangulated slabs for rectangular, L, U, V, C, II, irregular, G, flipped, and island configurations.

The saved payload records selections/quantities for sinks, hobs, tap holes, cuts, splashbacks, edging, and overhangs but not enough positions/contours to model them reliably. The exporter therefore:

- Writes configured operations as unresolved instead of inventing holes.
- Places islands and separate II-shape runs synthetically and marks those segments.
- Uses an expression-derived diffuse colour because no seamless texture is exposed.
- Omits splashbacks, wall edging strips, and unsupported overhang/waterfall contours with warnings.

### METHOD/HomeByMe

The high-level `method-export` command captures, maps, converts, and assembles a whole kitchen. The manual stages are:

```bash
node packages/cli/bin/ikea-assets.js capture-browser "<planner-url>" --out capture/playwright --save-bodies
node packages/cli/bin/ikea-assets.js map-assets capture/playwright/bodies/<project>.BMPROJ capture/playwright/manifest.json --metadata capture/playwright/bodies/<metadata> -o capture/playwright/asset-map.json --tsv capture/playwright/asset-map.tsv
node packages/cli/bin/ikea-assets.js convert capture/playwright/bodies -o assets/exported/live-home-3d --format obj --scale 0.001
node packages/cli/bin/ikea-assets.js assemble capture/playwright/bodies/<project>.BMPROJ capture/playwright/asset-map.json --obj-dir assets/exported/live-home-3d -o assets/whole-kitchen --whole --worktops --flat --axis y-up --name ikea-kitchen-livehome-flat-yup
```

METHOD source roles:

- `.BMPROJ`: placed furniture, `productResourceInfos`, and kitchen linears.
- `.BMA`: assembly metadata and active child relations, not mesh geometry.
- `.BM3`: mesh geometry, materials, transforms, and optional `scalingAreas`.
- `.BM3MAT`: material-only archive.

`map-assets` joins project resource IDs, the capture manifest, `/3/products`, and optional metadata/BOM responses. `assemble` recursively resolves active BMA children, applies nested transforms and BM3 scaling areas, and merges converted OBJ bundles.

`--worktops` generates triangulated slabs, extracts the captured BM3MAT texture, trims same-plane seams, and subtracts detected sink/hob/tap operation openings. The current cut-outs approximate rounded corners and circular tap holes as rectangular openings. `--plinths` creates 80mm-high, 10mm-thick strips from hidden kitchen-linear path edges.

For heavy Live Home 3D imports:

```bash
node packages/cli/bin/ikea-assets.js assemble <project.BMPROJ> <asset-map.json> --obj-dir assets/exported/live-home-3d -o assets/whole-kitchen --whole --worktops --flat --axis y-up --internal-parts omit --proxy-over-faces 500 --name ikea-kitchen-livehome-flat-yup-lite
```

`--internal-parts proxy|omit` classifies hidden drawer boxes, bins, internal shelves, pull-outs, support rails, and hidden integrated appliances. `--proxy-over-faces` replaces remaining high-detail leaves with fitted boxes. Both decisions are recorded per leaf.

## Output Review

Important outputs include:

- OBJ/MTL and texture sidecars.
- Family JSON reports with instance transforms, bounds, downloads, skipped entities, and warnings.
- `_source/plan.json`, catalog/product maps, and source GLBs where the family adapter persists them.
- METHOD `asset-map.tsv`, converted/named OBJ bundles, whole-kitchen assembly reports, and procedural material diagnostics.
- Preview PNGs plus `.preview-report.json`.

The checked-in environment template stores dashboard jobs under `/tmp/ikea-planner-exports`; this checkout's ignored `apps/web/.env.local` routes them to `assets/obj/`.

For Live Home 3D use Model Units `Meters`, Up Axis `Y`, and disable split instances when available. If complexity warnings remain, lower the importer level of detail or use METHOD proxy/omit controls.

Do not commit `capture/`, `assets/`, `node_modules/`, generated OBJ/MTL/GLB files, HARs, previews, or planner screenshots. They can be very large and may contain captured project data.

## Implementation Map

- `packages/planner-registry/index.js`: shared registry and CLI/web routing metadata.
- `packages/cli/bin/ikea-assets.js`: generated high-level commands and METHOD low-level commands.
- `packages/cli/src/preview.js`: Three.js/Playwright OBJ preview renderer.
- `packages/storage-one/src/`: Storage One profiles plus shared GLB decoder/OBJ exporter.
- `packages/space/src/`: public VPC/API-key discovery, current range catalogs, and Space entity analysis.
- `packages/sofas/src/`: sofa URL/catalog capture, entity resolution, and export report.
- `packages/enhet/src/`: CORO3 browser capture, ICF placement, and ENHET GLB resolution.
- `packages/method/src/`: HomeByMe capture, BM3 conversion, BMA assembly, worktops, cut-outs, plinths, and proxies.
- `packages/skytta/src/`: SKYTTA reference parsing, product assets, placed variant resolution, and export.
- `packages/worktop/src/`: CWCALC reference/configuration decoding, slab geometry, and OBJ/report writing.
- `apps/web/`: registry-driven local export queue, persisted job history, preview, and ZIP download.
- `docs/FORMAT_NOTES.md`: METHOD reverse-engineering notes.

## Verification

Use the smallest relevant package test plus the root regression suite:

```bash
npm test --workspace @ikea-planner-assets/sofas
npm test --workspace @ikea-planner-assets/worktop
npm test --workspace @ikea-planner-assets/skytta
npm test
```

Run opt-in live tests only when public IKEA access is expected:

```bash
npm run test:live --workspace @ikea-planner-assets/sofas
npm run test:live --workspace @ikea-planner-assets/worktop
npm run test:live --workspace @ikea-planner-assets/skytta
```

For generated OBJ bundles, verify report summaries, texture existence, fixed-angle previews, and final `v`, `vt`, `vn`, and `f` counts before handoff.
