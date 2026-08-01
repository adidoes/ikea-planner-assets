import { createWriteStream } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";
import { runNodeCommand } from "./command-runner";
import type { ExportAdapterInput, ExportAdapterResult, PlannerExportAdapter } from "./types";

export class CliPlannerExportAdapter implements PlannerExportAdapter {
  private readonly repoRoot: string;
  private readonly cliPath: string;

  constructor(options: { repoRoot?: string; cliPath?: string } = {}) {
    this.repoRoot = options.repoRoot ?? path.resolve(/* turbopackIgnore: true */ process.cwd(), "../..");
    this.cliPath =
      options.cliPath ??
      (process.env.IKEA_PLANNER_CLI_PATH
        ? path.resolve(/* turbopackIgnore: true */ process.env.IKEA_PLANNER_CLI_PATH)
        : path.join(this.repoRoot, "packages", "cli", "bin", "ikea-assets.js"));
  }

  async export(input: ExportAdapterInput): Promise<ExportAdapterResult> {
    const exportDir = path.join(input.workspaceDir, "export");
    const modelName = `${input.plannerType}-room-${input.jobId.slice(0, 8)}`;

    await Promise.all([
      mkdir(exportDir, { recursive: true }),
      mkdir(input.artifactDir, { recursive: true }),
    ]);

    await input.onProgress({
      phase: "capturing",
      progress: 8,
      detail: "Opening the shared planner and reading the project…",
    });
    let observedPhase: "capturing" | "downloading" | "exporting" = "capturing";
    await runNodeCommand(
      this.cliPath,
      [exportCommand(input.plannerType), input.plannerUrl, "--out", exportDir, "--name", modelName],
      {
        cwd: this.repoRoot,
        timeoutMs: commandTimeoutMs(),
        onLine: async (line) => {
          await input.onLog(line);
          const next = phaseFromLog(line);
          if (!next || phaseRank(next) <= phaseRank(observedPhase)) return;
          observedPhase = next;
          await input.onProgress(progressForLogPhase(next));
        },
      },
    );
    const model = await findModel(exportDir);
    if (!model) {
      throw new Error("The exporter finished without producing an OBJ model.");
    }

    let previewPath: string | undefined;
    if (!model.mtlPath) {
      await input.onLog("Preview warning: The OBJ has no matching MTL file, so no dashboard preview was rendered.");
    } else {
      try {
        previewPath = await renderPreview({
          cliPath: this.cliPath,
          repoRoot: this.repoRoot,
          artifactDir: input.artifactDir,
          objPath: model.objPath,
          mtlPath: model.mtlPath,
          onLog: input.onLog,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await input.onLog(`Preview warning: ${message.replace(/\s+/g, " ").slice(0, 500)}`);
      }
    }

    await input.onProgress({
      phase: "packaging",
      progress: 92,
      detail: "Packing the OBJ, materials, textures, and assembly report…",
    });
    const artifactName = `${modelName}-obj-bundle.zip`;
    const artifactPath = path.join(input.artifactDir, artifactName);
    await createZip(exportDir, artifactPath);

    return { artifactName, artifactPath, previewPath };
  }
}

function exportCommand(plannerType: ExportAdapterInput["plannerType"]): string {
  if (plannerType === "pax") return "pax-export";
  if (plannerType === "method") return "method-export";
  return "platsa-export";
}

function commandTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.IKEA_PLANNER_COMMAND_TIMEOUT_MS ?? "600000", 10);
  return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : 600_000;
}

function phaseFromLog(line: string): "capturing" | "downloading" | "exporting" | undefined {
  if (/export|convert|assembl|wrote.+\.(obj|mtl)/i.test(line)) return "exporting";
  if (/download|fetch|asset|mapping/i.test(line)) return "downloading";
  if (/capture|planner|project/i.test(line)) return "capturing";
  return undefined;
}

function phaseRank(phase: "capturing" | "downloading" | "exporting"): number {
  return { capturing: 0, downloading: 1, exporting: 2 }[phase];
}

function progressForLogPhase(phase: "capturing" | "downloading" | "exporting") {
  if (phase === "downloading") {
    return { phase, progress: 40, detail: "Downloading the furniture assets used by this design…" } as const;
  }
  if (phase === "exporting") {
    return { phase, progress: 70, detail: "Converting and assembling the OBJ model…" } as const;
  }
  return { phase, progress: 12, detail: "Reading the shared planner project…" } as const;
}

async function createZip(sourceDir: string, targetPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(targetPath, { flags: "wx" });
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("warning", (error) => {
      if (error.code !== "ENOENT") reject(error);
    });
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}

async function findModel(directory: string): Promise<{ objPath: string; mtlPath?: string } | undefined> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".obj")) {
      const objPath = path.join(directory, entry.name);
      const mtlName = `${entry.name.slice(0, -4)}.mtl`;
      const mtl = entries.find((candidate) => candidate.isFile() && candidate.name.toLowerCase() === mtlName.toLowerCase());
      return { objPath, mtlPath: mtl ? path.join(directory, mtl.name) : undefined };
    }
    if (entry.isDirectory()) {
      const nested = await findModel(path.join(directory, entry.name));
      if (nested) return nested;
    }
  }
  return undefined;
}

async function renderPreview(options: {
  cliPath: string;
  repoRoot: string;
  artifactDir: string;
  objPath: string;
  mtlPath: string;
  onLog: (line: string) => Promise<void>;
}): Promise<string> {
  const previewDir = path.join(options.artifactDir, "preview");
  await mkdir(previewDir, { recursive: true });
  await runNodeCommand(
    options.cliPath,
    [
      "preview",
      options.objPath,
      "--mtl",
      options.mtlPath,
      "--out",
      previewDir,
      "--angles",
      "iso",
      "--width",
      "960",
      "--height",
      "640",
    ],
    { cwd: options.repoRoot, timeoutMs: commandTimeoutMs(), onLine: options.onLog },
  );
  const entries = await readdir(previewDir, { withFileTypes: true });
  const image = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith("-iso.png"));
  if (!image) throw new Error("The preview renderer finished without producing an image.");
  return path.join(previewDir, image.name);
}
