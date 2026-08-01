export const EXPORT_PHASES = [
  { key: "queued", label: "Queued" },
  { key: "capturing", label: "Capturing planner" },
  { key: "downloading", label: "Downloading assets" },
  { key: "exporting", label: "Exporting geometry" },
  { key: "packaging", label: "Packaging bundle" },
  { key: "complete", label: "Ready" },
] as const;

export type ExportPhase = (typeof EXPORT_PHASES)[number]["key"];
export type ExportStatus = "queued" | "running" | "complete" | "failed";
export type PlannerType = "platsa" | "pax" | "method";

export interface ExportJob {
  id: string;
  plannerType: PlannerType;
  sourceUrl: string;
  status: ExportStatus;
  phase: ExportPhase;
  progress: number;
  detail: string;
  createdAt: string;
  updatedAt: string;
  artifactName?: string;
  artifactPath?: string;
  previewPath?: string;
  error?: string;
  logTail: string[];
}

export type PublicExportJob = Omit<ExportJob, "sourceUrl" | "artifactPath" | "previewPath"> & {
  downloadUrl?: string;
  previewUrl?: string;
};

export interface ProgressUpdate {
  phase: Exclude<ExportPhase, "queued" | "complete">;
  progress: number;
  detail: string;
}

export interface ExportAdapterInput {
  jobId: string;
  plannerType: PlannerType;
  plannerUrl: string;
  workspaceDir: string;
  artifactDir: string;
  onProgress: (update: ProgressUpdate) => Promise<void>;
  onLog: (line: string) => Promise<void>;
}

export interface ExportAdapterResult {
  artifactPath: string;
  artifactName: string;
  previewPath?: string;
}

export interface PlannerExportAdapter {
  export(input: ExportAdapterInput): Promise<ExportAdapterResult>;
}
