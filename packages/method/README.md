# METHOD downloader

This package contains the complete METHOD/HomeByMe pipeline: browser capture, asset mapping, BM3 conversion, assembly resolution, procedural worktops and plinths, and whole-kitchen OBJ export.

Its main interface is `exportMethodPlan(plannerUrl, options)`. The lower-level capture and conversion functions remain exported for the CLI's diagnostic commands.

```js
const { exportMethodPlan } = require("@ikea-planner-assets/method");

await exportMethodPlan(plannerUrl, {
  out: "assets/method",
  name: "my-method-kitchen",
  axis: "y-up",
});
```
