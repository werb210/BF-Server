// BF_SERVER_MAYA_CATALOG_AMOUNTS_v413
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(process.cwd(), "src/routes/mayaStaff.ts"), "utf8");

describe("v413 catalog.summary carries real ranges, not just counts", () => {
  it("aggregates amount, term and rate per category", () => {
    expect(src).toContain("BF_SERVER_MAYA_CATALOG_AMOUNTS_v413");
    for (const f of // v432 - v429 corrected these to the columns lender_products actually has.
    ["min_amount", "max_amount", "term_min", "term_max", "rate_min_num", "rate_max_num"]) {
      expect(src).toContain(f);
    }
  });

  it("aggregates so no single lender product is identifiable", () => {
    expect(src).toContain("GROUP BY category");
    expect(src).not.toContain("lenders.name");
  });

  it("tells the model never to quote a number outside this data", () => {
    expect(src).toContain("Never quote an amount, term or rate that is not in this data");
  });

  it("returns the structured categories alongside the prose summary", () => {
    expect(src).toContain("byCategory: categories, categories, summary");
  });
});
