import { NextResponse } from "next/server";
import { exportJobManager } from "@/lib/export-jobs/manager";
import { InputValidationError, validateJobId } from "@/lib/export-jobs/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    const job = await exportJobManager.get(validateJobId(jobId));
    if (!job) return NextResponse.json({ error: "Export job not found." }, { status: 404 });
    return NextResponse.json(job, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InputValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Could not read export job", error);
    return NextResponse.json({ error: "The export status could not be read." }, { status: 500 });
  }
}
