import { NextResponse } from "next/server";
import { exportJobManager, JobCapacityError } from "@/lib/export-jobs/manager";
import { InputValidationError, validatePlannerType, validatePlannerUrl } from "@/lib/export-jobs/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 4_096;

export async function GET() {
  try {
    const jobs = await exportJobManager.list();
    return NextResponse.json({ jobs }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not list export jobs", error);
    return NextResponse.json({ error: "The export history could not be read." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: "The request body is too large." }, { status: 413 });
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return NextResponse.json({ error: "Send the request as application/json." }, { status: 415 });
    }

    const body = await readJsonBody(request, MAX_REQUEST_BYTES);
    const plannerUrl = validatePlannerUrl(
      body && typeof body === "object" && "url" in body ? (body as { url?: unknown }).url : undefined,
    );
    const plannerType = validatePlannerType(
      body && typeof body === "object" && "plannerType" in body
        ? (body as { plannerType?: unknown }).plannerType
        : undefined,
    );
    const job = await exportJobManager.create(plannerUrl, plannerType);
    return NextResponse.json(job, {
      status: 202,
      headers: { Location: `/api/exports/${job.id}`, "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "The request body is not valid JSON." }, { status: 400 });
    }
    if (error instanceof InputValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof JobCapacityError) {
      return NextResponse.json(
        { error: error.message },
        { status: 429, headers: { "Retry-After": "10" } },
      );
    }
    console.error("Could not create export job", error);
    return NextResponse.json({ error: "The exporter could not start a job." }, { status: 500 });
  }
}


class RequestBodyTooLargeError extends Error {
  constructor() {
    super("The request body is too large.");
    this.name = "RequestBodyTooLargeError";
  }
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.body) return JSON.parse("");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
