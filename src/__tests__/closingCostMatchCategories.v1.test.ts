import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// BF_SERVER_CLOSING_COST_MATCH_CATEGORIES_v1 - guards that the step-2 closing-cost
// companion writes metadata.match_categories (the array the lender-match engine reads),
// not just closing_cost_routing.
// BF_SERVER_CLOSING_COST_LOC_OVER_50K_v1 - the routing is now binary: under $50k
// TERM, $50k and over LOC. It is never both.
const src = readFileSync(
  fileURLToPath(new URL("../routes/client/v1Applications.ts", import.meta.url)),
  "utf-8",
);

describe("step-2 closing-cost companion match categories", () => {
  it("sets match_categories from the routing decision", () => {
    expect(src).toContain(
      'match_categories: closingCostRouting === "loc" ? ["LOC"] : ["TERM"]',
    );
  });
  it("keeps the routing string alongside the array", () => {
    expect(src).toContain("closing_cost_routing: closingCostRouting");
  });
});
