import { afterEach, describe, expect, it } from "vitest";
import {
  InputValidationError,
  validateJobId,
  validatePlannerType,
  validatePlannerUrl,
} from "./validation";

const originalAllowedHosts = process.env.IKEA_PLANNER_ALLOWED_HOSTS;

afterEach(() => {
  process.env.IKEA_PLANNER_ALLOWED_HOSTS = originalAllowedHosts;
});

describe("validatePlannerUrl", () => {
  it("accepts and normalizes an IKEA https URL", () => {
    expect(validatePlannerUrl(" https://www.ikea.com/addon-app/platsa/?id=123#room ")).toBe(
      "https://www.ikea.com/addon-app/platsa/?id=123#room",
    );
  });

  it("preserves the fragment containing a PLATSA plan id", () => {
    const shareUrl = "https://www.ikea.com/addon-app/storageone/platsa/web/latest/#/vpc/337F9K6";
    expect(validatePlannerUrl(shareUrl)).toBe(shareUrl);
  });

  it("preserves the fragment containing a PAX plan id", () => {
    const shareUrl = "https://www.ikea.com/addon-app/storageone/pax/web/latest/be/en/?vpcSource=clipboard#/vpc/337LMDY";
    expect(validatePlannerUrl(shareUrl)).toBe(shareUrl);
  });

  it("rejects non-https and non-IKEA URLs", () => {
    expect(() => validatePlannerUrl("http://www.ikea.com/planner")).toThrow(InputValidationError);
    expect(() => validatePlannerUrl("https://example.com/planner")).toThrow(/hosted by IKEA/);
  });

  it("permits configured planner hosts", () => {
    process.env.IKEA_PLANNER_ALLOWED_HOSTS = "planner.example.test";
    expect(validatePlannerUrl("https://planner.example.test/share/abc")).toBe(
      "https://planner.example.test/share/abc",
    );
  });
});

describe("validateJobId", () => {
  it("only accepts v4 UUIDs", () => {
    expect(validateJobId("c0a8012e-c5a6-4af1-8f00-b945c081867a")).toBe(
      "c0a8012e-c5a6-4af1-8f00-b945c081867a",
    );
    expect(() => validateJobId("../../capture")).toThrow(InputValidationError);
  });
});

describe("validatePlannerType", () => {
  it("defaults old clients to PLATSA and normalizes the old kitchen label", () => {
    expect(validatePlannerType(undefined)).toBe("platsa");
    expect(validatePlannerType("platsa")).toBe("platsa");
    expect(validatePlannerType("pax")).toBe("pax");
    expect(validatePlannerType("method")).toBe("method");
    expect(validatePlannerType("kitchen")).toBe("method");
  });

  it("rejects unknown planners", () => {
    expect(() => validatePlannerType("besta")).toThrow(/PLATSA, PAX, or METHOD/);
  });
});
