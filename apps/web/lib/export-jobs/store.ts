import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PLANNER_SLUG, normalizePlannerSlug } from "@ikea-planner-assets/planner-registry";
import type { ExportJob } from "./types";

export class ExportJobStore {
  readonly rootDir = path.resolve(
    /* turbopackIgnore: true */
    process.env.IKEA_PLANNER_EXPORT_WORK_DIR || path.join(os.tmpdir(), "ikea-planner-exports"),
  );
  private cache = new Map<string, ExportJob>();

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  jobDir(jobId: string): string {
    return path.join(/* turbopackIgnore: true */ this.rootDir, jobId);
  }

  workspaceDir(jobId: string): string {
    return path.join(this.jobDir(jobId), "work");
  }

  artifactDir(jobId: string): string {
    return path.join(this.jobDir(jobId), "artifacts");
  }

  async create(job: ExportJob): Promise<void> {
    await mkdir(this.artifactDir(job.id), { recursive: true });
    this.cache.set(job.id, job);
    await this.persist(job);
  }

  async get(jobId: string): Promise<ExportJob | undefined> {
    const cached = this.cache.get(jobId);
    if (cached) return cached;
    try {
      const job = normalizeStoredJob(
        JSON.parse(await readFile(path.join(this.jobDir(jobId), "job.json"), "utf8")) as ExportJob,
      );
      if (job.status === "queued" || job.status === "running") {
        job.status = "failed";
        job.detail = "Export stopped before the bundle was created.";
        job.error = "The local server restarted while this export was running. Submit the planner link again.";
        job.updatedAt = new Date().toISOString();
        await this.persist(job);
      }
      this.cache.set(jobId, job);
      return job;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<ExportJob[]> {
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const jobs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name))
        .map((entry) => this.get(entry.name)),
    );
    return jobs
      .filter((job): job is ExportJob => Boolean(job))
      .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt));
  }

  async save(job: ExportJob): Promise<void> {
    job.updatedAt = new Date().toISOString();
    this.cache.set(job.id, job);
    await this.persist(job);
  }

  async cleanExpired(): Promise<void> {
    const ttlHours = Number.parseFloat(process.env.IKEA_PLANNER_JOB_TTL_HOURS ?? "24");
    const ttlMs = (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 24) * 60 * 60 * 1_000;
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name))
        .map(async (entry) => {
          const target = this.jobDir(entry.name);
          const info = await stat(target);
          if (now - info.mtimeMs <= ttlMs) return;
          this.cache.delete(entry.name);
          await rm(target, { recursive: true, force: true });
        }),
    );
  }

  private async persist(job: ExportJob): Promise<void> {
    const destination = path.join(this.jobDir(job.id), "job.json");
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  }
}

function normalizeStoredJob(job: Omit<ExportJob, "plannerType"> & { plannerType?: string }): ExportJob {
  const plannerType = normalizePlannerSlug(job.plannerType) ?? DEFAULT_PLANNER_SLUG;
  return {
    ...job,
    plannerType,
  };
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
