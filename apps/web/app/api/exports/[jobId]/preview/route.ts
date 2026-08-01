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
    if (!job.previewPath) {
      return NextResponse.json({ error: "No preview is available for this export." }, { status: 404 });
    }
    if (!exportJobManager.isArtifactPathAllowed(job.id, job.previewPath)) {
      return NextResponse.json({ error: "The preview path is invalid." }, { status: 500 });
    }
    if (pathExtension(job.previewPath) !== ".png") {
      return NextResponse.json({ error: "The preview format is invalid." }, { status: 500 });
    }

    const info = await stat(job.previewPath);
    const stream = Readable.toWeb(createReadStream(job.previewPath)) as ReadableStream;
    return new Response(stream, {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(info.size),
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof InputValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "The preview has expired." }, { status: 410 });
    }
    console.error("Could not open export preview", error);
    return NextResponse.json({ error: "The preview could not be opened." }, { status: 500 });
  }
}

function pathExtension(filePath: string): string {
  const index = filePath.lastIndexOf(".");
  return index >= 0 ? filePath.slice(index).toLowerCase() : "";
}
