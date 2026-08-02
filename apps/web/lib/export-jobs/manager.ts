import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PLANNER_SLUG } from "@ikea-planner-assets/planner-registry";
import { CliPlannerExportAdapter } from "./cli-adapter";
import { ExportJobStore } from "./store";
import type { ExportJob, PlannerExportAdapter, PlannerType, PublicExportJob } from "./types";

export class JobCapacityError extends Error {
  constructor() {
    super("The local export queue is full. Try again after one of the current exports finishes.");
    this.name = "JobCapacityError";
  }
}

export class ExportJobManager {
  private readonly store = new ExportJobStore();
  private readonly adapter: PlannerExportAdapter;
  private readonly queue: ExportJob[] = [];
  private running = 0;
  private initialized?: Promise<void>;
  private lastCleanupAt = 0;
  private pendingAdmissions = 0;

  constructor(adapter: PlannerExportAdapter = new CliPlannerExportAdapter()) {
    this.adapter = adapter;
  }

  async create(sourceUrl: string, plannerType: PlannerType = DEFAULT_PLANNER_SLUG): Promise<PublicExportJob> {
    await this.initialize();
    await this.cleanExpiredIfDue();
    if (this.queue.length + this.pendingAdmissions >= maxQueuedJobs()) {
      throw new JobCapacityError();
    }
    this.pendingAdmissions += 1;
    const timestamp = new Date().toISOString();
    const job: ExportJob = {
      id: randomUUID(),
      plannerType,
      sourceUrl,
      status: "queued",
      phase: "queued",
      progress: 0,
      detail: "Waiting for the local exporter…",
      createdAt: timestamp,
      updatedAt: timestamp,
      logTail: [],
    };
    try {
      await this.store.create(job);
      this.queue.push(job);
      this.drain();
      return await this.toPublicJob(job);
    } finally {
      this.pendingAdmissions -= 1;
    }
  }

  async get(jobId: string): Promise<PublicExportJob | undefined> {
    await this.initialize();
    const job = await this.store.get(jobId);
    return job ? this.toPublicJob(job) : undefined;
  }

  async list(): Promise<PublicExportJob[]> {
    await this.initialize();
    await this.cleanExpiredIfDue();
    const jobs = await this.store.list();
    return Promise.all(jobs.map((job) => this.toPublicJob(job)));
  }

  async getInternal(jobId: string): Promise<ExportJob | undefined> {
    await this.initialize();
    return this.store.get(jobId);
  }

  isArtifactPathAllowed(jobId: string, artifactPath: string): boolean {
    const artifactDir = `${path.resolve(/* turbopackIgnore: true */ this.store.artifactDir(jobId))}${path.sep}`;
    return path.resolve(/* turbopackIgnore: true */ artifactPath).startsWith(artifactDir);
  }

  private initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.store.initialize()
        .then(() => this.store.cleanExpired())
        .then(() => { this.lastCleanupAt = Date.now(); })
        .catch((error) => {
          this.initialized = undefined;
          throw error;
        });
    }
    return this.initialized;
  }

  private async cleanExpiredIfDue(): Promise<void> {
    const intervalMinutes = Number.parseFloat(process.env.IKEA_PLANNER_CLEANUP_INTERVAL_MINUTES ?? "60");
    const intervalMs = (Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 60) * 60 * 1_000;
    if (Date.now() - this.lastCleanupAt < intervalMs) return;
    await this.store.cleanExpired();
    this.lastCleanupAt = Date.now();
  }

  private drain(): void {
    const limit = Math.max(1, Number.parseInt(process.env.IKEA_PLANNER_MAX_CONCURRENT_JOBS ?? "1", 10) || 1);
    while (this.running < limit && this.queue.length) {
      const job = this.queue.shift();
      if (!job) return;
      this.running += 1;
      void this.run(job).finally(() => {
        this.running -= 1;
        this.drain();
      });
    }
  }

  private async run(job: ExportJob): Promise<void> {
    try {
      job.status = "running";
      await this.store.save(job);
      const result = await this.adapter.export({
        jobId: job.id,
        plannerType: job.plannerType,
        plannerUrl: job.sourceUrl,
        workspaceDir: this.store.workspaceDir(job.id),
        artifactDir: this.store.artifactDir(job.id),
        onProgress: async (update) => {
          job.status = "running";
          job.phase = update.phase;
          job.progress = Math.max(job.progress, Math.min(99, update.progress));
          job.detail = update.detail;
          await this.store.save(job);
        },
        onLog: async (line) => {
          job.logTail = [...job.logTail, line].slice(-16);
          await this.store.save(job);
        },
      });
      job.status = "complete";
      job.phase = "complete";
      job.progress = 100;
      job.detail = "Your OBJ bundle is ready to download.";
      job.artifactName = result.artifactName;
      job.artifactPath = result.artifactPath;
      job.previewPath = result.previewPath;
      await this.store.save(job);
    } catch (error) {
      job.status = "failed";
      job.detail = "Export stopped before the bundle was created.";
      job.error = friendlyError(error);
      await this.store.save(job);
    }
  }

  private async toPublicJob(job: ExportJob): Promise<PublicExportJob> {
    const {
      artifactPath: _artifactPath,
      previewPath: _previewPath,
      sourceUrl: _sourceUrl,
      ...publicJob
    } = job;
    const hasPreview = Boolean(
      job.previewPath
      && this.isArtifactPathAllowed(job.id, job.previewPath)
      && await fileExists(job.previewPath),
    );
    return {
      ...publicJob,
      downloadUrl: job.status === "complete" ? `/api/exports/${job.id}/download` : undefined,
      previewUrl: hasPreview ? `/api/exports/${job.id}/preview` : undefined,
    };
  }
}

function friendlyError(error: unknown): string {
  if (!(error instanceof Error)) return "An unexpected exporter error occurred.";
  const message = error.message.replace(/\s+/g, " ").trim();
  return message.slice(0, 800) || "An unexpected exporter error occurred.";
}

function maxQueuedJobs(): number {
  const parsed = Number.parseInt(process.env.IKEA_PLANNER_MAX_QUEUED_JOBS ?? "8", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 8;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __ikeaPlannerExportJobManager: ExportJobManager | undefined;
}

export const exportJobManager =
  globalThis.__ikeaPlannerExportJobManager && typeof globalThis.__ikeaPlannerExportJobManager.list === "function"
    ? globalThis.__ikeaPlannerExportJobManager
    : (globalThis.__ikeaPlannerExportJobManager = new ExportJobManager());
