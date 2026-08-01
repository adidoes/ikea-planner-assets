# Planner Exporter Dashboard

A local Next.js dashboard for turning accessible PLATSA, PAX, and METHOD planner share URLs into downloadable OBJ bundles. It keeps an export history, shows job details and previews, and invokes the matching repository command in an isolated per-job directory.

## Run locally

Install the monorepo and browser runtime from the repository root (`bun install` and `bunx playwright install chromium` when Chromium is missing). The web app uses Bun.

```bash
bun install
cp apps/web/.env.example apps/web/.env.local
bun run web:dev
```

Open `http://localhost:3000`, choose PLATSA, PAX, or METHOD, paste an IKEA share URL that is accessible without a sign-in, and leave the local server running while the export completes.

## Configuration

See `apps/web/.env.example`. Defaults work when this app remains at `apps/web/` inside the repository. In particular:

- `IKEA_PLANNER_CLI_PATH` overrides the monorepo CLI entry point.
- `IKEA_PLANNER_EXPORT_WORK_DIR` controls where isolated job data and ZIP artifacts are stored.
- `IKEA_PLANNER_ALLOWED_HOSTS` adds trusted planner hosts to the built-in `ikea.com` allowlist.
- `IKEA_PLANNER_JOB_TTL_HOURS` controls artifact retention.
- `IKEA_PLANNER_CLEANUP_INTERVAL_MINUTES` controls throttled cleanup while the server remains running.
- `IKEA_PLANNER_COMMAND_TIMEOUT_MS` stops a stalled browser/export process.
- `IKEA_PLANNER_MAX_QUEUED_JOBS` bounds the waiting queue and defaults to eight.

The server accepts one job at a time by default. Set `IKEA_PLANNER_MAX_CONCURRENT_JOBS` to a positive integer only if the machine can safely run multiple browser captures and geometry conversions together.

## API

- `GET /api/exports` lists persisted jobs newest first.
- `POST /api/exports` with `{ "url": "https://…", "plannerType": "platsa" }` creates a job and returns HTTP 202. Use `"pax"` for PAX or `"method"` for METHOD.
- `GET /api/exports/:jobId` returns current phase, progress, log tail, and any terminal error.
- `GET /api/exports/:jobId/preview` streams the generated PNG preview when available.
- `GET /api/exports/:jobId/download` streams the finished ZIP bundle.

Job metadata is also written to `<work-dir>/<job-id>/job.json`, so completed exports remain downloadable across server restarts. Jobs that were in flight during a restart must be submitted again.

## Verify

```bash
bun run web:test
bun run web:build
```
