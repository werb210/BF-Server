// BF_SERVER_BLOCK_v84_COMPANION_ROUTING_BY_AMOUNT_v1
// BF_SERVER_CLOSING_COST_LOC_OVER_50K_v1 - this file used to declare its own
// copy of the companion formula and assert against that copy, so it passed no
// matter what the route actually did (it was asserting 20% while the submit-time
// normalizer already used 15%). Assert against the real source instead.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  fileURLToPath(new URL("../v1Applications.ts", import.meta.url)),
  "utf-8",
);

describe("closing-cost companion routing", () => {
  it("uses 15% of the parent amount everywhere, never 20%", () => {
    expect(src).toContain("Math.round(parentAmt * 0.15)");
    expect(src).toContain("Math.round(primaryAmount * 0.15)");
    expect(src).toContain("ROUND(amt * 0.15)");
    expect(src).not.toContain("primaryAmount * 0.2");
  });

  it("caps the companion at $250k", () => {
    expect(src).toContain("250000");
  });

  it("routes under $50k to TERM and $50k+ to LOC, never both", () => {
    expect(src).toContain('>= 50000 ? "loc" : "term"');
    expect(src).toContain('companionAmount < 50_000 ? ["TERM"] : ["LOC"]');
    expect(src).not.toContain("term_and_loc\" :");
    expect(src).not.toContain('["TERM", "LOC"]');
  });

  it("sets product_category to match the routing decision", () => {
    expect(src).toContain('closingCostRouting === "loc" ? "LOC" : "Term Loan"');
    expect(src).toContain("THEN 'LOC' ELSE 'TERM' END");
  });
});
