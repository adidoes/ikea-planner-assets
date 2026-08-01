import type { PlannerType } from "./types";

const DEFAULT_ALLOWED_SUFFIXES = ["ikea.com"];

export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

export function validatePlannerUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InputValidationError("Enter an IKEA planner share URL.");
  }

  if (value.length > 2_048) {
    throw new InputValidationError("The planner URL is too long.");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new InputValidationError("Enter a complete URL beginning with https://.");
  }

  if (url.protocol !== "https:") {
    throw new InputValidationError("Planner URLs must use https://.");
  }

  if (url.username || url.password) {
    throw new InputValidationError("Planner URLs cannot contain credentials.");
  }

  const extraHosts = (process.env.IKEA_PLANNER_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const hostname = url.hostname.toLowerCase();
  const isAllowed = [...DEFAULT_ALLOWED_SUFFIXES, ...extraHosts].some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );

  if (!isAllowed) {
    throw new InputValidationError(
      "Use a share link hosted by IKEA. Additional planner hosts can be enabled by the server administrator.",
    );
  }

  return url.toString();
}

export function validateJobId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new InputValidationError("Invalid export job identifier.");
  }
  return value;
}

export function validatePlannerType(value: unknown): PlannerType {
  if (value === undefined || value === null || value === "") return "platsa";
  if (value === "platsa") return "platsa";
  if (value === "pax") return "pax";
  if (value === "method" || value === "kitchen") return "method";
  throw new InputValidationError("Choose the PLATSA, PAX, or METHOD planner.");
}
