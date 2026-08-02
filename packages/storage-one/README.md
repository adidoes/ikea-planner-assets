# Storage One export module

This package owns the shared capture, placement, GLB decoding, material conversion, and OBJ export implementation used by IKEA's Storage One planners. Planner-specific behavior is selected through registry-backed profiles rather than duplicated source trees.

`exportStorageOnePlan(input, options, profile)` accepts a public share URL or plan id and a planner slug, captures the version-matched VPC/catalog responses, downloads the product GLBs, and writes one OBJ/MTL bundle plus source files and a report. `exportPlatsaPlan` and `exportPaxPlan` remain convenient named wrappers.

```js
const { exportPaxPlan, exportPlatsaPlan } = require("@ikea-planner-assets/storage-one");

await exportPlatsaPlan("337F9K6", {
  out: "assets/platsa",
  retailUnit: "BE",
  language: "en",
  axis: "y-up",
  modelVariant: "compatible"
});

await exportPaxPlan("337LMDY", {
  out: "assets/pax",
  retailUnit: "BE",
  language: "en",
  axis: "y-up",
});
```

Supported profiles are derived from the shared planner registry and currently cover BESTÅ, BILLY, BOAXEL, BROR, EKET, ELVARLI, IVAR, JONAXEL, KALLAX, KNOXHULT, LÅDMAKARE, LASTARE, PAX, PLATSA, and SMÅSTAD.

`modelVariant: "compatible"` (the default) downloads baseline GLBs, whose embedded JPEG/PNG textures are more portable to OBJ importers. `modelVariant: "optimized"` uses the planner's smaller Draco/WebP GLBs when available.

The exporter enumerates exact world-space transforms from `configuration.content.entities` and enriches them with ICF hierarchy/dimension diagnostics. Entity translations and catalog `modelTransform` translations are millimetres; GLB vertices are already metres. Output defaults to Y-up.

The package interface also exposes lower-level helpers for capture, catalog extraction, GLB decoding, OBJ export, and reference parsing. Draco decoding uses the decoder bundled with `three`.
