"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Box,
  Check,
  Download,
  ExternalLink,
  FileArchive,
  HardDrive,
  Link2,
  LoaderCircle,
  PackageOpen,
  Plus,
} from "lucide-react";
import {
  DEFAULT_PLANNER_SLUG,
  PLANNERS,
  getPlanner,
  normalizePlannerSlug,
} from "@ikea-planner-assets/planner-registry";

import type { PlannerType, PublicExportJob } from "@/lib/export-jobs/types";
import { extractPlanId } from "@/lib/export-jobs/plan-reference";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { PlannerLogo } from "@/components/planner-logo";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

const HISTORY_KEY = "planner-exporter.jobs.v1";
const PHASES = ["capturing", "downloading", "exporting", "packaging"] as const;
const FAMILY_LABELS: Record<string, string> = {
  storage: "Storage systems",
  space: "Rooms and furniture",
  kitchen: "Kitchens",
  sofas: "Sofas",
  worktop: "Worktops",
};

type JobRecord = Omit<PublicExportJob, "plannerType"> & {
  plannerType?: PlannerType;
  previewUrl?: string;
  sourceUrl?: string;
};

interface ApiError {
  error?: string;
}

export function Exporter() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(true);
  const [plannerType, setPlannerType] = useState<PlannerType>(DEFAULT_PLANNER_SLUG);
  const [url, setUrl] = useState("");
  const [requestError, setRequestError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAbort = useRef<AbortController | null>(null);
  const pollGeneration = useRef(0);
  const urlInput = useRef<HTMLInputElement | null>(null);

  const selectedJob = useMemo(
    () => jobs.find((candidate) => candidate.id === selectedId) ?? null,
    [jobs, selectedId],
  );

  const clearPoll = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    pollAbort.current?.abort();
    pollAbort.current = null;
    pollGeneration.current += 1;
  }, []);

  const mergeJob = useCallback((job: JobRecord, context?: Partial<JobRecord>) => {
    setJobs((current) => {
      const existing = current.find((candidate) => candidate.id === job.id);
      const next: JobRecord = {
        ...existing,
        ...context,
        ...job,
        plannerType: normalizePlannerType(job.plannerType) ?? normalizePlannerType(context?.plannerType) ?? existing?.plannerType ?? DEFAULT_PLANNER_SLUG,
        sourceUrl: context?.sourceUrl ?? job.sourceUrl ?? existing?.sourceUrl,
      };
      const updated = [next, ...current.filter((candidate) => candidate.id !== job.id)].sort(
        (left, right) => timestamp(right.createdAt) - timestamp(left.createdAt),
      );
      saveHistory(updated);
      return updated;
    });
  }, []);

  const poll = useCallback(async (jobId: string, generation: number, context?: Partial<JobRecord>) => {
    if (generation !== pollGeneration.current) return;
    const controller = new AbortController();
    pollAbort.current = controller;
    try {
      const response = await fetch(`/api/exports/${encodeURIComponent(jobId)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = (await response.json()) as JobRecord & ApiError;
      if (generation !== pollGeneration.current) return;
      if (!response.ok) {
        const message = body?.error || "Export status is unavailable.";
        if (response.status === 429 || response.status >= 500) throw new Error(message);
        setRequestError(message);
        return;
      }

      mergeJob(body, context);
      setRequestError("");
      if (body.status === "queued" || body.status === "running") {
        pollTimer.current = setTimeout(() => void poll(jobId, generation, context), 1_000);
      }
    } catch (error) {
      if (controller.signal.aborted || generation !== pollGeneration.current) return;
      setRequestError(error instanceof Error ? error.message : "Export status is unavailable.");
      pollTimer.current = setTimeout(() => void poll(jobId, generation, context), 3_000);
    }
  }, [mergeJob]);

  useEffect(() => {
    const stored = loadHistory();
    const controller = new AbortController();
    setJobs(stored);

    async function hydrateJobs() {
      let available = stored;
      try {
        const response = await fetch("/api/exports", { cache: "no-store", signal: controller.signal });
        const body = (await response.json()) as { jobs?: JobRecord[] } & ApiError;
        if (response.ok && Array.isArray(body.jobs)) {
          available = body.jobs.map((job) => {
            const local = stored.find((candidate) => candidate.id === job.id);
            return {
              ...local,
              ...job,
              plannerType: normalizePlannerType(job.plannerType) ?? local?.plannerType ?? DEFAULT_PLANNER_SLUG,
              sourceUrl: local?.sourceUrl,
            };
          });
          setJobs(available);
          saveHistory(available);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
      }

      const requestedId = new URLSearchParams(window.location.search).get("job");
      const initialId = requestedId || available[0]?.id || null;
      if (!initialId || controller.signal.aborted) return;
      setSelectedId(initialId);
      setIsCreating(false);
      const existing = available.find((candidate) => candidate.id === initialId);
      void poll(initialId, pollGeneration.current, existing);
    }

    void hydrateJobs();
    return () => {
      controller.abort();
      clearPoll();
    };
  }, [clearPoll, poll]);

  function beginNewExport() {
    clearPoll();
    setSelectedId(null);
    setIsCreating(true);
    setRequestError("");
    window.history.replaceState(null, "", window.location.pathname);
    window.setTimeout(() => urlInput.current?.focus(), 0);
  }

  function selectJob(job: JobRecord) {
    clearPoll();
    setSelectedId(job.id);
    setIsCreating(false);
    setRequestError("");
    window.history.replaceState(null, "", `?job=${encodeURIComponent(job.id)}`);
    void poll(job.id, pollGeneration.current, job);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearPoll();
    setRequestError("");
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, plannerType }),
      });
      const body = (await response.json()) as JobRecord & ApiError;
      if (!response.ok) throw new Error(body?.error || "The export could not be started.");
      const context: Partial<JobRecord> = { plannerType, sourceUrl: url };
      mergeJob(body, context);
      setSelectedId(body.id);
      setIsCreating(false);
      window.history.replaceState(null, "", `?job=${encodeURIComponent(body.id)}`);
      void poll(body.id, pollGeneration.current, context);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The export could not be started.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="dashboard-shell">
      <aside className="dashboard-sidebar" aria-label="Export navigation">
        <div className="sidebar-brand">
          <PlannerLogo />
          <div>
            <strong>Planner Exporter</strong>
            <span>Local workspace</span>
          </div>
        </div>

        <Button className="new-export-button" onClick={beginNewExport}>
          <Plus size={16} />
          New export
        </Button>

        <Separator />

        <div className="sidebar-section-heading">
          <span>Exported plans</span>
          <Badge variant="secondary">{jobs.length}</Badge>
        </div>

        <ScrollArea className="job-scroll-area">
          <nav className="job-list" aria-label="Exported plans">
            {jobs.length ? jobs.map((job) => (
              <button
                type="button"
                className={`job-list-item ${selectedId === job.id && !isCreating ? "is-selected" : ""}`}
                key={job.id}
                onClick={() => selectJob(job)}
                aria-current={selectedId === job.id && !isCreating ? "page" : undefined}
              >
                <span className="job-item-icon" aria-hidden="true">
                  {job.status === "complete" ? <PackageOpen size={17} /> : job.status === "failed" ? <AlertCircle size={17} /> : <LoaderCircle className="spin" size={17} />}
                </span>
                <span className="job-item-copy">
                  <strong>{jobName(job)}</strong>
                  <span>{plannerLabel(job.plannerType)} · {relativeTime(job.updatedAt || job.createdAt)}</span>
                </span>
                <StatusDot status={job.status} />
              </button>
            )) : (
              <div className="job-list-empty">
                <FileArchive size={20} aria-hidden="true" />
                <p>No exports yet</p>
                <span>Created plans will appear here.</span>
              </div>
            )}
          </nav>
        </ScrollArea>

        <div className="sidebar-footer">
          <HardDrive size={14} aria-hidden="true" />
          <span>Files stay on this machine</span>
        </div>
      </aside>

      <main className="dashboard-main">
        {isCreating ? (
          <NewExportView
            url={url}
            setUrl={setUrl}
            plannerType={plannerType}
            setPlannerType={setPlannerType}
            isSubmitting={isSubmitting}
            requestError={requestError}
            onSubmit={submit}
            inputRef={urlInput}
          />
        ) : selectedJob ? (
          <JobDetail job={selectedJob} requestError={requestError} onNewExport={beginNewExport} />
        ) : (
          <EmptySelection onNewExport={beginNewExport} />
        )}
      </main>
    </div>
  );
}

function NewExportView({
  url,
  setUrl,
  plannerType,
  setPlannerType,
  isSubmitting,
  requestError,
  onSubmit,
  inputRef,
}: {
  url: string;
  setUrl: (value: string) => void;
  plannerType: PlannerType;
  setPlannerType: (value: PlannerType) => void;
  isSubmitting: boolean;
  requestError: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const selectedPlanner = getPlanner(plannerType) ?? getPlanner(DEFAULT_PLANNER_SLUG)!;
  const plannerGroups = Array.from(
    PLANNERS.reduce((groups, planner) => {
      const family = planner.family || "other";
      const entries = groups.get(family) || [];
      entries.push(planner);
      groups.set(family, entries);
      return groups;
    }, new Map<string, (typeof PLANNERS)[number][]>()).entries(),
  );

  return (
    <div className="detail-page new-export-page">
      <header className="detail-header">
        <div>
          <p className="detail-eyebrow">Planner export</p>
          <h1>New export</h1>
          <p>Create a local OBJ bundle from a planner share link.</p>
        </div>
      </header>

      <Card className="new-export-card">
        <CardHeader>
          <CardTitle>Export settings</CardTitle>
          <CardDescription>Select the planner and paste its saved design URL.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="new-export-form" onSubmit={onSubmit} noValidate>
            <div className="form-field">
              <label htmlFor="planner-type">Planner</label>
              <div className="planner-picker">
                <select
                  id="planner-type"
                  className="planner-select"
                  value={plannerType}
                  onChange={(event) => setPlannerType(event.target.value as PlannerType)}
                  disabled={isSubmitting}
                >
                  {plannerGroups.map(([family, planners]) => (
                    <optgroup key={family} label={FAMILY_LABELS[family] || "Other planners"}>
                      {planners.map((planner) => (
                        <option key={planner.slug} value={planner.slug}>{planner.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <div className="planner-selection-summary" aria-live="polite">
                  <span aria-hidden="true"><Box size={17} /></span>
                  <div><strong>{selectedPlanner.label}</strong><small>{selectedPlanner.description}</small></div>
                </div>
              </div>
            </div>

            <div className="form-field">
              <label htmlFor="planner-url">Planner share URL</label>
              <div className="url-input-wrap">
                <Link2 size={16} aria-hidden="true" />
                <Input
                  ref={inputRef}
                  id="planner-url"
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  placeholder="https://www.ikea.com/…"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  disabled={isSubmitting}
                  required
                  aria-describedby="url-help"
                />
              </div>
              <p id="url-help">Use a saved design link that opens without signing in.</p>
            </div>

            {requestError ? <InlineError message={requestError} /> : null}

            <div className="form-actions">
              <Button type="submit" disabled={isSubmitting || !url.trim()}>
                {isSubmitting ? <LoaderCircle className="spin" size={16} /> : <PackageOpen size={16} />}
                {isSubmitting ? "Starting export…" : "Start export"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function JobDetail({ job, requestError, onNewExport }: { job: JobRecord; requestError: string; onNewExport: () => void }) {
  const running = job.status === "queued" || job.status === "running";
  return (
    <div className="detail-page">
      <header className="detail-header job-detail-header">
        <div>
          <p className="detail-eyebrow">{plannerLabel(job.plannerType)} planner</p>
          <div className="title-with-badges">
            <h1>{jobName(job)}</h1>
            <StatusBadge status={job.status} />
          </div>
          <p>Updated {formatDate(job.updatedAt || job.createdAt)}</p>
        </div>
        <div className="header-actions">
          {job.status === "complete" && job.downloadUrl ? (
            <Button asChild>
              <a href={job.downloadUrl}><Download size={16} />Download ZIP</a>
            </Button>
          ) : null}
          <Button variant="outline" onClick={onNewExport}><Plus size={16} />New export</Button>
        </div>
      </header>

      {requestError ? <InlineError message={requestError} /> : null}

      <div className="detail-grid">
        <Card className="preview-card">
          <CardHeader>
            <div>
              <CardTitle>Preview</CardTitle>
              <CardDescription>Exported model</CardDescription>
            </div>
            <Badge variant="outline">OBJ</Badge>
          </CardHeader>
          <CardContent>
            <div className={`preview-stage ${job.previewUrl ? "has-image" : ""}`}>
              {job.previewUrl ? (
                // A renderer may add this optional URL without changing the dashboard.
                <img src={job.previewUrl} alt={`Preview of ${jobName(job)}`} />
              ) : (
                <div className="preview-placeholder">
                  {running ? <LoaderCircle className="spin" size={28} /> : <Box size={30} />}
                  <strong>{running ? "Preview pending" : "No preview available"}</strong>
                  <span>{running ? "The model is still being prepared." : "Download the bundle to inspect the model."}</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="status-card">
          <CardHeader>
            <div>
              <CardTitle>Export status</CardTitle>
              <CardDescription>{job.detail}</CardDescription>
            </div>
            <strong className="progress-value">{job.progress}%</strong>
          </CardHeader>
          <CardContent>
            <Progress value={job.progress} aria-label="Export progress" />
            <ol className="phase-list" aria-label="Export phases">
              {PHASES.map((phase, index) => {
                const current = phaseIndex(job.phase);
                const complete = job.status === "complete" || index < current;
                const active = index === current && job.status !== "failed";
                return (
                  <li className={complete ? "is-complete" : active ? "is-active" : ""} key={phase}>
                    <span aria-hidden="true">{complete ? <Check size={12} /> : index + 1}</span>
                    {phaseLabel(phase)}
                  </li>
                );
              })}
            </ol>
            {job.status === "failed" && job.error ? <InlineError message={job.error} /> : null}
            {job.logTail?.length ? (
              <details className="technical-details">
                <summary>Technical details</summary>
                <pre>{job.logTail.join("\n")}</pre>
              </details>
            ) : null}
          </CardContent>
        </Card>

        <Card className="metadata-card">
          <CardHeader>
            <CardTitle>Details</CardTitle>
            <CardDescription>Planner and bundle information</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="metadata-list">
              <MetadataRow label="Planner" value={plannerLabel(job.plannerType)} />
              <MetadataRow label="Format" value="OBJ / MTL / textures" />
              <MetadataRow label="Created" value={formatDate(job.createdAt)} />
              <MetadataRow label="Job ID" value={job.id} mono />
              {job.artifactName ? <MetadataRow label="Artifact" value={job.artifactName} mono /> : null}
            </dl>
            {job.sourceUrl ? (
              <a className="source-link" href={job.sourceUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={14} />Open source plan
              </a>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function EmptySelection({ onNewExport }: { onNewExport: () => void }) {
  return (
    <div className="empty-selection">
      <FileArchive size={32} aria-hidden="true" />
      <h1>Select an export</h1>
      <p>Choose a plan from the sidebar or start a new export.</p>
      <Button onClick={onNewExport}><Plus size={16} />New export</Button>
    </div>
  );
}

function MetadataRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? "mono" : undefined}>{value}</dd></div>;
}

function InlineError({ message }: { message: string }) {
  return <div className="inline-error" role="alert"><AlertCircle size={16} /><span>{message}</span></div>;
}

function StatusDot({ status }: { status: JobRecord["status"] }) {
  return <span className={`status-dot status-${status}`} aria-label={status} />;
}

function StatusBadge({ status }: { status: JobRecord["status"] }) {
  const variant = status === "complete" ? "success" : status === "failed" ? "destructive" : "pending";
  return <Badge variant={variant}>{status === "running" ? "In progress" : capitalize(status)}</Badge>;
}

function loadHistory(): JobRecord[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is JobRecord => Boolean(item && typeof item === "object" && "id" in item && typeof item.id === "string"));
  } catch {
    return [];
  }
}

function saveHistory(jobs: JobRecord[]) {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(jobs.slice(0, 100)));
  } catch {}
}

function normalizePlannerType(value: unknown): PlannerType | undefined {
  return normalizePlannerSlug(value);
}

function plannerLabel(type: unknown): string {
  return getPlanner(type)?.label ?? getPlanner(DEFAULT_PLANNER_SLUG)!.label;
}

function jobName(job: JobRecord): string {
  const planId = extractPlanId(job.sourceUrl);
  if (planId) return `${plannerLabel(job.plannerType)} ${planId}`;
  const artifact = job.artifactName?.replace(/\.zip$/i, "").replace(/[-_]+/g, " ").trim();
  if (artifact) return artifact;
  return `${plannerLabel(job.plannerType)} ${job.id.slice(0, 8)}`;
}

function phaseIndex(phase: JobRecord["phase"]): number {
  if (phase === "queued") return -1;
  if (phase === "complete") return PHASES.length;
  return PHASES.indexOf(phase as (typeof PHASES)[number]);
}

function phaseLabel(phase: (typeof PHASES)[number]): string {
  return ({ capturing: "Capture", downloading: "Assets", exporting: "Geometry", packaging: "Package" })[phase];
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function timestamp(value?: string): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function relativeTime(value?: string): string {
  const elapsed = Date.now() - timestamp(value);
  if (!value || !Number.isFinite(elapsed)) return "Recently";
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

function formatDate(value?: string): string {
  if (!value || !timestamp(value)) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
