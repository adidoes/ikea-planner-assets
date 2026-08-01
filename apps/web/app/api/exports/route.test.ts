import { describe, expect, it, vi } from "vitest";
import { exportJobManager } from "@/lib/export-jobs/manager";
import { POST } from "./route";

describe("POST /api/exports", () => {
  it("enforces the body limit even without a Content-Length header", async () => {
    const response = await POST(new Request("http://localhost/api/exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://www.ikea.com/planner", padding: "x".repeat(5_000) }),
    }));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "The request body is too large." });
  });

  it("returns validation errors for null JSON and unknown planners", async () => {
    const nullResponse = await POST(jsonRequest(null));
    expect(nullResponse.status).toBe(400);

    const plannerResponse = await POST(jsonRequest({
      url: "https://www.ikea.com/planner/example",
      plannerType: "besta",
    }));
    expect(plannerResponse.status).toBe(400);
    await expect(plannerResponse.json()).resolves.toEqual({
      error: "Choose the PLATSA, PAX, or METHOD planner.",
    });
  });

  it("accepts PAX and admits a canonical PAX job", async () => {
    const create = vi.spyOn(exportJobManager, "create").mockResolvedValueOnce({
      id: "1ca145b1-b0e9-4b1c-9659-d7687950d78e",
      plannerType: "pax",
      status: "queued",
      phase: "queued",
      progress: 0,
      detail: "Waiting for the local exporter…",
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
      logTail: [],
    });
    const url = "https://www.ikea.com/addon-app/storageone/pax/web/latest/be/en/?vpcSource=clipboard#/vpc/337LMDY";

    const response = await POST(jsonRequest({ url, plannerType: "pax" }));

    expect(response.status).toBe(202);
    expect(create).toHaveBeenCalledWith(url, "pax");
    await expect(response.json()).resolves.toMatchObject({ plannerType: "pax" });
    create.mockRestore();
  });
});

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/exports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
