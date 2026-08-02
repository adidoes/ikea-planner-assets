import { describe, expect, it } from "vitest";
import { extractPlanId } from "./plan-reference";

describe("extractPlanId", () => {
  it.each([
    ["Storage One", "https://www.ikea.com/addon-app/storageone/pax/web/latest/be/en/#/vpc/337LMDY", "337LMDY"],
    ["Storage One gallery", "https://www.ikea.com/addon-app/storageone/knoxhult/web/latest/be/en/#/planner?vpc=VLJ8WK", "VLJ8WK"],
    ["Space", "https://www.ikea.com/addon-app/space/platform/latest/be/en/#/open/337M5VD", "337M5VD"],
    ["sofa", "https://www.ikea.com/addon-app/sofas/jattebo/web/latest/be/en/#/337M6TL", "337M6TL"],
    ["SKYTTA", "https://www.ikea.com/addon-app/skytta/web/latest/be/en/?designCode=337M6KW#/planner", "337M6KW"],
    ["worktop", "https://www.ikea.com/be/en/planner/custom-worktop-calculator/#/337M78D/", "337M78D"],
  ])("extracts the %s public design code", (_label, url, expected) => {
    expect(extractPlanId(url)).toBe(expected);
  });

  it("returns null for non-design planner pages", () => {
    expect(extractPlanId("https://www.ikea.com/be/en/planners/")).toBeNull();
  });
});
