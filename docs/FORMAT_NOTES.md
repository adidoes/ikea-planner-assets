# IKEA/HomeByMe Planner Asset Notes

Current evidence points to a HomeByMe/ByMe planner embedded inside the IKEA shell.

Observed outer page:

- `https://kitchen.planner.ikea.com/be/en/planner/<project-id>/`
- Embeds `https://kitchen.ikea-prod.by.me/Kitchen/?ln=en-BE&projectId=<project-id>`

Likely asset hosts from the embedded app CSP:

- `https://d1rnl1hhzmmov0.cloudfront.net/`
- `https://d26ku3b8guqhu2.cloudfront.net/`
- `https://byme-ikea-prod.s3.eu-west-1.amazonaws.com/`
- `https://platform.ikea-prod.by.me/`

Bundle references worth following:

- `catalog.default_agg.br`
- `FullInfos.json`
- `Metadata.json`
- `.br`
- `.geom`
- `.texture`
- debug/dev paths named `generateMetaData`, `generateExpandedMetaData`, and `getFullTree`

Updated capture result:

- Parent-page Playwright capture found the actual model payloads.
- Geometry/model archives are served from `d1rnl1hhzmmov0.cloudfront.net` as `/<uuid>/BM3/Lod_1_std.BM3`.
- Material-only archives are served from `d26ku3b8guqhu2.cloudfront.net` as `/<uuid>/BM3MAT/Lod_1_std.BM3MAT`.
- Product assembly/parameter metadata is served as `/<uuid>/BMA/root.BMA`.
- `.BM3` and `.BM3MAT` are ZIP containers with:
  - `manifest.json`
  - `binary.bin`
- `manifest.json` uses a ByMe C++ exporter schema. It includes `header`, `materials`, `textures`, `images`, `geometries`, `buffers`, `vertexLayouts`, `nodes`, and `root`.
- Vertex buffers observed so far use interleaved `POSITION:FLOAT3`, `NORMAL:FLOAT3`, `TEX_COORD_0:FLOAT2`, which maps cleanly to glTF accessors with 32-byte stride.

Working interpretation:

- `.br` is often Brotli-compressed data, but the planner may also use `.br` as a logical catalog extension. The inspector tries Brotli first and records failures.
- `.geom` / `.mesh` appear in bundle internals, but the live planner loaded `.BM3` ZIP model archives for this plan.
- `.BM3` can now be converted directly to `.glb`.
- `.BM3` nodes may include `scalingAreas`. The assembly step applies those stretch zones from resolved `.BMA` `width`, `depth`, and `height` overloads before placement, which keeps parametric fronts/drawers/rails closer to the planner's closed/rest state.
- `.BMA` files may include an `animation` block for openable doors and drawers. The whole-kitchen OBJ export currently uses the closed/rest placement and does not bake animated open states.
- Worktops/countertops are represented as planner `linears.worktops` data plus a material-only `.BM3MAT`, not as downloadable countertop mesh geometry. The `assemble --worktops` path generates rectangular procedural slab geometry from each worktop's furniture IDs, altitude, thickness, and material. Sink/hob cutouts are still approximated rather than subtracted.
- `.texture`, `.basis`, `.ktx2`, and image files are texture dependencies, not standalone furniture models.
- Live Home 3D import should be targeted through `OBJ` first for this pipeline. `GLB` remains useful as a normalized interchange/debug artifact.

Recommended capture and Live Home 3D export flow:

```bash
npm run test
node bin/ikea-assets.js index-bundles capture/bundles -o capture/meta/bundle-index.json
node bin/ikea-assets.js capture-browser "https://kitchen.planner.ikea.com/be/en/planner/296A373C-D0E2-4BDB-B7CC-B69FF4441452/" --out capture/playwright --save-bodies
node bin/ikea-assets.js inspect capture/playwright/bodies -o capture/playwright/decoded
node bin/ikea-assets.js convert capture/playwright/bodies -o assets/exported/live-home-3d --format obj --scale 0.001
node bin/ikea-assets.js convert capture/playwright/bodies -o assets/exported/glb --format glb --scale 0.001
```

The `--scale 0.001` option converts ByMe millimeter units to meters. For OBJ export, node transforms and local geometry are both scaled consistently.

Live Home 3D import notes:

- Live Home 3D's official import article lists Wavefront OBJ and Collada among supported 3D model import formats.
- Its current Mac help also lists OBJ, Collada, Collada Zipped, FBX, 3DS, SKP, KMZ, Ogre XML, USDZ, and others.
- Use the generated `.obj` file with its sibling `.mtl` file and texture directory kept together.

If automated capture misses session-bound requests, use DevTools on the working planner page:

1. Open DevTools -> Network.
2. Reload the planner.
3. Filter for `.br`, `.geom`, `.texture`, `cloudfront`, `byme-ikea-prod`, or `FullInfos`.
4. Export a HAR or copy selected requests as cURL into a local file.
5. Run `node bin/ikea-assets.js import-requests <file> -o capture/manifest.json`.

Do not commit auth-bearing HAR/cURL files. Treat them as secrets if they include cookies or bearer tokens.
