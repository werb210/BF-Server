// BF_SERVER_AD_SPEND_ANALYSIS_v1
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const route = fs.readFileSync(
  path.resolve(__dirname, "../marketing/adSpendAnalysis.ts"), "utf8");
const warehouse = fs.readFileSync(
  path.resolve(__dirname, "../../services/googleAdsWarehouse.ts"), "utf8");

describe("ad spend analysis", () => {
  it("reads the search terms the warehouse already collects", () => {
    // googleAdsWarehouse pulls search_term_view daily; nothing read it.
    expect(warehouse).toContain("FROM search_term_view");
    expect(route).toContain("level = 'search_term'");
  });

  it("isolates spend that produced no conversion at all", () => {
    expect(route).toContain("HAVING SUM(conversions) = 0 AND SUM(cost) > 0");
  });

  it("reports the wasted share, not just a list", () => {
    // The number that decides whether to cut the budget.
    expect(route).toContain("wastedShare");
  });

  it("also shows what does work, so terms can be compared", () => {
    expect(route).toContain("whatWorks");
    expect(route).toContain("cost_per_conversion");
  });

  it("separates bid keywords from actual searches", () => {
    // A keyword performing while its search terms do not means broad match is
    // buying traffic nobody asked for.
    expect(route).toContain("level = 'keyword'");
  });

  it("guards against divide-by-zero on cost per conversion", () => {
    expect(route).toContain("NULLIF(SUM(conversions), 0)");
    expect(route).toContain("NULLIF(SUM(clicks), 0)");
  });

  it("bounds the window and the row count", () => {
    expect(route).toContain("n <= 730");
    expect(route.match(/LIMIT 100/g)?.length).toBe(3);
  });
});
