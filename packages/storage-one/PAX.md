# PAX profile

`exportPaxPlan(input, options)` accepts a public PAX share URL or a plan id. It uses the shared Storage One DEXF capture and GLB-to-OBJ pipeline also used by PLATSA, while keeping PAX-specific URLs, output names, logs, and report schemas.

```js
const { exportPaxPlan } = require("@ikea-planner-assets/storage-one");

await exportPaxPlan("337LMDY", {
  out: "assets/pax",
  retailUnit: "BE",
  language: "en",
  axis: "y-up",
  modelVariant: "compatible"
});
```

`modelVariant: "compatible"` downloads baseline GLBs with broadly portable textures. `modelVariant: "optimized"` prefers the planner's smaller Draco/WebP assets. Output coordinates are metres and Y-up by default.
