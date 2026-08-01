import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { exportJobManager } from "@/lib/export-jobs/manager";
import { InputValidationError, validateJobId } from "@/lib/export-jobs/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    const job = await exportJobManager.getInternal(validateJobId(jobId));
    if (!job) return NextResponse.json({ error: "Export job not found." }, { status: 404 });
    if (job.status !== "complete" || !job.artifactPath || !job.artifactName) {
      return NextResponse.json({ error: "The export bundle is not ready yet." }, { status: 409 });
    }
    if (!exportJobManager.isArtifactPathAllowed(job.id, job.artifactPath)) {
      return NextResponse.json({ error: "The export bundle path is invalid." }, { status: 500 });
    }

    const info = await stat(job.artifactPath);
    const stream = Readable.toWeb(createReadStream(job.artifactPath)) as ReadableStream;
    return new Response(stream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(info.size),
        "Content-Disposition": `attachment; filename="${job.artifactName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof InputValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "The export bundle has expired." }, { status: 410 });
    }
    console.error("Could not download export bundle", error);
    return NextResponse.json({ error: "The export bundle could not be opened." }, { status: 500 });
  }
}
