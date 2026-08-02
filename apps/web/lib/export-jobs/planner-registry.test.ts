import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLANNER_SLUG,
  PLANNERS,
  getPlanner,
  normalizePlannerSlug,
  plannerChoiceMessage,
} from "@ikea-planner-assets/planner-registry";

describe("planner registry", () => {
  it("provides unique dashboard and CLI metadata for every supported planner", () => {
    expect(PLANNERS.some((planner) => planner.slug === DEFAULT_PLANNER_SLUG)).toBe(true);
    expect(new Set(PLANNERS.map((planner) => planner.slug)).size).toBe(PLANNERS.length);
    expect(new Set(PLANNERS.map((planner) => planner.cli.command)).size).toBe(PLANNERS.length);

    for (const planner of PLANNERS) {
      expect(getPlanner(planner.slug)).toBe(planner);
      expect(planner.label).not.toBe("");
      expect(planner.description).not.toBe("");
      expect(planner.cli.command).toMatch(/-export$/);
    }
  });

  it("owns legacy aliases and builds the validation copy from registered labels", () => {
    expect(normalizePlannerSlug(" KITCHEN ")).toBe("method");
    expect(normalizePlannerSlug("unsupported")).toBeUndefined();
    for (const planner of PLANNERS) expect(plannerChoiceMessage()).toContain(planner.label);
  });
});
