# IKEA Planner Assets

Local tools for turning accessible IKEA saved designs into portable OBJ bundles. The monorepo has adapters for several unrelated IKEA planner runtimes: DEXF/GLB planners, ENHET/CORO3, METHOD/HomeByMe kitchens, the Custom Worktop Calculator, and SKYTTA.

The normal input is a public IKEA share URL. Most adapters also accept a bare design code when the planner family, retail unit, and language are known. The normal output is a Y-up, metre-based OBJ, MTL, any usable textures, and a JSON report that records sources, placements, skipped geometry, and limitations.

## Quick start

```bash
bun install
bunx playwright install chromium
npm test
bun run web:test
```

List every generated export command:

```bash
node packages/cli/bin/ikea-assets.js --help
```

Public means the design must open without an IKEA account sign-in. Prefer the complete share URL because it carries the planner family and locale; a code copied from one market may return 404 in another.

## Capability matrix

The shared registry in `packages/planner-registry` is the source of truth for the CLI and dashboard. It contains 38 exportable planner entries: 15 Storage One, 13 Space, six sofa ranges, METHOD, ENHET, SKYTTA, and Custom Worktop.

| Family | Implemented planners | Saved input and geometry path | Output and important boundary |
| --- | --- | --- | --- |
| Storage One | BESTÅ, BILLY, BOAXEL, BROR, EKET, ELVARLI, IVAR, JONAXEL, KALLAX, KNOXHULT, LÅDMAKARE, LASTARE, PAX, PLATSA, SMÅSTAD | Public VPC share URL/code; Playwright captures the DEXF scene and catalog, then downloads placed GLBs | OBJ/MTL/textures, captured plan/catalog/GLBs, and a planner-specific report. PAX and PLATSA have dedicated regression fixtures; the remaining planners are profiles over the same adapter. |
| IKEA Space | Outdoor, Bathroom, Dining room, Hallway, Children's room, Bedroom, Living room, Home office, Dining chair, Dining table, Dining set, Desk, MITTZON | Public Space share URL/code; direct VPC retrieval plus current range catalogs and placed GLBs | OBJ/MTL/textures, source files, and `.space-report.json`. Room shells and catalog-only assembly containers are omitted. |
| Sofa planners | JÄTTEBO, KIVIK, VIMLE, UPPÅKRA, SÖDERHAMN, LILLEHEM | Public saved-design hash/code; Playwright captures the VPC snapshot, versioned catalog, and module GLBs | OBJ/MTL/embedded textures and `.sofa-report.json`. A standalone SPR product link is not a placed design; share it from the planner first. |
| ENHET | ENHET kitchen planner | Public CORO3 VPC URL/code; Playwright captures the ICF plan and ENHET catalog, then downloads GLBs | OBJ/MTL/textures, source plan/catalog/GLBs, and `.enhet-report.json`. Only catalog articles with model assets and transforms are exported. |
| METHOD | METHOD kitchen planner | A loaded/shared HomeByMe planner URL, or the lower-level captured `.BMPROJ`/manifest workflow; BM3/BMA/BM3MAT geometry and assembly data | Whole-kitchen or item OBJ bundles with textures, procedural worktops/plinths, and `.assembly-report.json`. This is the deepest adapter and has explicit complexity/proxy controls. |
| SKYTTA | SKYTTA sliding-door planner | Public `designCode` URL/code; VPC scene plus Webplanner product assets | OBJ/MTL/embedded textures, source plan/product map/GLBs, and `.skytta-report.json`. Room geometry, BOM-only fittings, and unresolved multi-asset variants are omitted and reported. |
| Custom Worktop | IKEA Custom Worktop Calculator | Public CWCALC saved URL/code; dimensions and selections are converted into procedural slab meshes | OBJ/MTL and `.worktop-report.json`. The public payload has no cut-out positions, room placement, or seamless surface textures, so those are never invented. |
| Guides/navigator | Appliance guide, Storage guide, Mattress guide, Sofa navigator | **Not exportable** | These are discovery/advice tools and do not expose a public saved 3D design with placed transforms and model assets. If one hands off to a supported planner, export the resulting planner share link. |
| IKEA Kreativ | IKEA Kreativ room design | **Not implemented** | Kreativ uses a separate scene pipeline from the adapters in this repository. It is intentionally absent from the registry, CLI, and dashboard; do not route it through the Space adapter. |

## CLI exports

Every registered planner has a high-level command. Use `--retail-unit` and `--language` when a bare code does not belong to the default `BE`/`en` locale.

Storage One:

```bash
node packages/cli/bin/ikea-assets.js platsa-export "https://www.ikea.com/addon-app/storageone/platsa/web/latest/be/en/?vpcSource=clipboard#/vpc/337F9K6" --out assets/platsa --name my-platsa
node packages/cli/bin/ikea-assets.js pax-export 337LMDY --retail-unit BE --language en --out assets/pax --name my-pax
```

IKEA Space and product configurators:

```bash
node packages/cli/bin/ikea-assets.js living-room-export "https://www.ikea.com/addon-app/space/platform/latest/be/en/#/open/337M5VD" --out assets/living-room
node packages/cli/bin/ikea-assets.js mittzon-export <public-code> --retail-unit BE --language en --out assets/mittzon
```

Sofas:

```bash
node packages/cli/bin/ikea-assets.js jattebo-export "https://www.ikea.com/addon-app/sofas/jattebo/web/latest/be/en/#/337M6TL" --out assets/jattebo --name my-jattebo
```

Kitchens:

```bash
node packages/cli/bin/ikea-assets.js enhet-export "https://www.ikea.com/addon-app/coro3/planner/latest/be/en/#/vpc/337M6P4" --out assets/enhet
node packages/cli/bin/ikea-assets.js method-export "<loaded-method-planner-url>" --out assets/method --name my-method-kitchen
```

SKYTTA and Custom Worktop:

```bash
node packages/cli/bin/ikea-assets.js skytta-export "https://www.ikea.com/addon-app/skytta/web/latest/be/en/?designCode=337M6KW#/planner" --out assets/skytta --name my-skytta
node packages/cli/bin/ikea-assets.js worktop-export "https://www.ikea.com/be/en/planner/custom-worktop-calculator/#/337M78D/" --out assets/worktop --name my-worktop
```

Storage One and Space default to compatibility-oriented GLBs. `--model-variant optimized` can reduce downloads when the importer supports the resulting compressed/WebP assets. All high-level commands accept `--axis y-up|z-up`; Y-up is the default.

## Web dashboard

The local Bun + Next.js dashboard reads the same registry and invokes the matching CLI exporter. It persists job history, streams capture/download/export progress, renders an isometric preview when possible, and packages the complete output directory as a ZIP.

```bash
cp apps/web/.env.example apps/web/.env.local
bun run web:dev
```

Open `http://localhost:3000`, choose the planner, and paste a public HTTPS IKEA share URL. The web form intentionally requires a URL; use the CLI for bare codes. Jobs run one at a time by default because browser capture and geometry conversion are memory-intensive.

Useful settings include:

- `IKEA_PLANNER_EXPORT_WORK_DIR`: isolated job and ZIP storage. The template uses `/tmp/ikea-planner-exports`; this checkout's ignored local configuration uses `assets/obj/`.
- `IKEA_PLANNER_MAX_CONCURRENT_JOBS`: concurrent exporters; default `1`.
- `IKEA_PLANNER_MAX_QUEUED_JOBS`: queue bound; default `8`.
- `IKEA_PLANNER_COMMAND_TIMEOUT_MS`: stalled command timeout.
- `IKEA_PLANNER_ALLOWED_HOSTS`: additional trusted share-link hosts.

See `apps/web/README.md` for the HTTP API and retention settings.

## Output conventions and caveats

- High-level exporters write metre-based OBJ geometry and default to Y-up. For Live Home 3D use Model Units `Meters`, Up Axis `Y`, and keep split-object import off when possible.
- Keep the OBJ, MTL, and texture directory together. MTL texture paths are relative to the export directory.
- OBJ/MTL cannot reproduce the full glTF physically based material model. The shared GLB exporter preserves base-colour factors, embedded base-colour textures, opacity, and a useful roughness/specular approximation.
- DEXF-derived exports include only placed, mesh-backed entities. Missing catalog entries, unsupported primitive modes, containers without meshes, and failed downloads remain visible in the report.
- SKYTTA's current runtime can load a byte-identical CDN alias instead of the Webplanner model URL. Use the report's model association and content hash rather than treating a URL difference alone as different geometry.
- Public designs can depend on the market and on IKEA's current catalog deployment. Account-only/private plans are outside the supported retrieval paths.
- `_source/` directories and reports are diagnostic evidence, not disposable noise. They make model selection and placement failures auditable.
- The Custom Worktop export intentionally has no texture sidecars. Its approximate MTL colour comes from saved material/expression labels.
- Generated `capture/`, `assets/`, OBJ/MTL/GLB files, HARs, previews, and planner screenshots are local artifacts and must not be committed.

## METHOD/HomeByMe details

`method-export` performs capture, asset mapping, BM3 conversion, and whole-kitchen assembly in one command. It enables procedural worktops and plinths, writes one flat Y-up object, and removes its temporary capture directory after success unless the package API is given a persistent `workDir`.

For reverse engineering or partial recovery, run the stages separately:

```bash
node packages/cli/bin/ikea-assets.js capture-browser "<planner-url>" --out capture/playwright --save-bodies
node packages/cli/bin/ikea-assets.js map-assets capture/playwright/bodies/<project>.BMPROJ capture/playwright/manifest.json --metadata capture/playwright/bodies/<metadata> -o capture/playwright/asset-map.json --tsv capture/playwright/asset-map.tsv
node packages/cli/bin/ikea-assets.js convert capture/playwright/bodies -o assets/exported/live-home-3d --format obj --scale 0.001
node packages/cli/bin/ikea-assets.js assemble capture/playwright/bodies/<project>.BMPROJ capture/playwright/asset-map.json --obj-dir assets/exported/live-home-3d -o assets/whole-kitchen --whole --worktops --flat --axis y-up --name ikea-kitchen-livehome-flat-yup
node packages/cli/bin/ikea-assets.js preview assets/whole-kitchen/ikea-kitchen-livehome-flat-yup.obj --mtl assets/whole-kitchen/ikea-kitchen-livehome-flat-yup.mtl -o assets/previews/kitchen
```

Important METHOD details:

- `.BMPROJ` supplies placed furniture, product/resource bindings, and linear kitchen data.
- `.BMA` is assembly metadata; `.BM3` carries geometry; `.BM3MAT` is material-only.
- `assemble` resolves active child relations and BM3 `scalingAreas`, which keeps parametric fronts, rails, shelves, drawers, and frames fitted to the saved dimensions.
- `--worktops` generates triangulated slabs, captured material mapping, seam trimming, and rectangular sink/hob/tap openings from detected operations. `--plinths` exports toe-kick path strips.
- `--internal-parts proxy|omit` handles hidden cabinet contents. `--proxy-over-faces 1000` or `500` replaces high-detail leaves with fitted boxes when Live Home 3D reports excessive complexity.
- METHOD remains a practical reconstruction rather than a pixel-perfect renderer: rounded cut-out corners and circular tap holes are approximated.

## Package interfaces

The CLI is a thin adapter over workspace APIs:

```js
const { exportStorageOnePlan } = require("@ikea-planner-assets/storage-one");
const { exportSpacePlan } = require("@ikea-planner-assets/space");
const { exportSofaPlan } = require("@ikea-planner-assets/sofas");
const { exportEnhetPlan } = require("@ikea-planner-assets/enhet");
const { exportMethodPlan } = require("@ikea-planner-assets/method");
const { exportSkyttaPlan } = require("@ikea-planner-assets/skytta");
const { exportWorktopPlan } = require("@ikea-planner-assets/worktop");

await exportStorageOnePlan(codeOrUrl, { out: "assets/pax" }, "pax");
await exportSofaPlan(codeOrUrl, { out: "assets/jattebo" }, "jattebo");
```

## Monorepo layout

- `packages/planner-registry`: canonical planner names, families, CLI commands, aliases, and adapter routing shared by CLI/web.
- `packages/cli`: the `ikea-assets` entry point, METHOD low-level commands, and OBJ preview renderer.
- `packages/storage-one`: shared Storage One capture, catalog parsing, GLB decoding, material extraction, placement, and OBJ export.
- `packages/space`: direct public VPC/catalog pipeline for Space rooms and furniture configurators.
- `packages/sofas`: versioned sofa catalog capture and placed module export.
- `packages/enhet`: ENHET/CORO3 browser capture and ICF/GLB export.
- `packages/method`: METHOD/HomeByMe capture, BM3 conversion, assembly resolution, and procedural kitchen geometry.
- `packages/skytta`: SKYTTA VPC/product catalog capture and sliding-door GLB export.
- `packages/worktop`: Custom Worktop saved-payload decoder and procedural slab exporter.
- `apps/web`: local Next.js job dashboard and ZIP/preview service.
- `docs/FORMAT_NOTES.md`: reverse-engineering notes for captured planner formats.

## Verification

```bash
npm test
bun run web:test
bun run web:build
bun run test:all
```

Package-level live tests are opt-in because they depend on public IKEA services:

```bash
npm run test:live --workspace @ikea-planner-assets/sofas
npm run test:live --workspace @ikea-planner-assets/worktop
npm run test:live --workspace @ikea-planner-assets/skytta
```

For any generated bundle, inspect its report, confirm each `map_Kd` target exists, render an OBJ preview, and check `v`, `vt`, `vn`, and `f` counts before handing it to a 3D importer.
