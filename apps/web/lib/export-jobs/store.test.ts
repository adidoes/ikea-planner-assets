import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExportJobStore } from "./store";
import type { ExportJob } from "./types";

const temporaryDirectories: string[] = [];
const originalWorkDir = process.env.IKEA_PLANNER_EXPORT_WORK_DIR;

afterEach(async () => {
  if (originalWorkDir === undefined) delete process.env.IKEA_PLANNER_EXPORT_WORK_DIR;
  else process.env.IKEA_PLANNER_EXPORT_WORK_DIR = originalWorkDir;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ExportJobStore.list", () => {
  it("loads persisted jobs newest-first, preserves PAX, and normalizes legacy planner types", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "export-job-store-test-"));
    temporaryDirectories.push(root);
    process.env.IKEA_PLANNER_EXPORT_WORK_DIR = root;
    const store = new ExportJobStore();
    await store.initialize();

    const newer = makeJob({
      id: "dcabf8ee-a72c-4011-b4ea-5d072c7fb13f",
      plannerType: "method",
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    await store.create(newer);

    const pax = makeJob({
      id: "1ca145b1-b0e9-4b1c-9659-d7687950d78e",
      plannerType: "pax",
      createdAt: "2026-08-01T11:00:00.000Z",
    });
    await store.create(pax);

    const kitchenId = "959c69d7-b66c-4696-812f-c30c8db73143";
    const kitchenDir = store.jobDir(kitchenId);
    await mkdir(kitchenDir, { recursive: true });
    const kitchen = makeJob({ id: kitchenId, createdAt: "2026-08-01T10:00:00.000Z" });
    await writeFile(path.join(kitchenDir, "job.json"), JSON.stringify({ ...kitchen, plannerType: "kitchen" }), "utf8");

    const legacyId = "ecfbb5f2-457c-4a53-846a-26b6b9f7a120";
    const legacyDir = store.jobDir(legacyId);
    await mkdir(legacyDir, { recursive: true });
    const legacy = makeJob({ id: legacyId, createdAt: "2026-07-31T12:00:00.000Z" });
    const { plannerType: _plannerType, ...legacyWithoutType } = legacy;
    await writeFile(path.join(legacyDir, "job.json"), JSON.stringify(legacyWithoutType), "utf8");

    const jobs = await store.list();
    expect(jobs.map((job) => job.id)).toEqual([newer.id, pax.id, kitchenId, legacyId]);
    expect(jobs.map((job) => job.plannerType)).toEqual(["method", "pax", "method", "platsa"]);
  });
});

function makeJob(overrides: Partial<ExportJob> & Pick<ExportJob, "id" | "createdAt">): ExportJob {
  return {
    id: overrides.id,
    plannerType: "platsa",
    sourceUrl: "https://www.ikea.com/planner/example",
    status: "complete",
    phase: "complete",
    progress: 100,
    detail: "Ready",
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
    logTail: [],
    ...overrides,
  };
}
