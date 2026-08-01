# Storage One export module

This package owns the shared capture, placement, GLB decoding, material conversion, and OBJ export implementation used by both PLATSA and PAX. Planner-specific behavior is selected through explicit profiles rather than duplicated source trees.

`exportPlatsaPlan(input, options)` and `exportPaxPlan(input, options)` accept a public share URL or plan id, capture the version-matched VPC/catalog responses, download the product GLBs, and write one OBJ/MTL bundle plus source files and a report.

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

`modelVariant: "compatible"` (the default) downloads baseline GLBs, whose embedded JPEG/PNG textures are more portable to OBJ importers. `modelVariant: "optimized"` uses the planner's smaller Draco/WebP GLBs when available.

The exporter enumerates exact world-space transforms from `configuration.content.entities` and enriches them with ICF hierarchy/dimension diagnostics. Entity translations and catalog `modelTransform` translations are millimetres; GLB vertices are already metres. Output defaults to Y-up.

The package interface also exposes lower-level helpers for capture, catalog extraction, GLB decoding, OBJ export, and reference parsing. Draco decoding uses the decoder bundled with `three`.
