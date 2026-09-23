// BF_SERVER_CATALOG_COLUMNS_v429
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const src = readFileSync(path.join(process.cwd(), "src/routes/mayaStaff.ts"), "utf8");
const migrations = readFileSync(
  path.join(process.cwd(), "migrations/2026_05_24_v647_lender_products_seed.sql"), "utf8");

describe("v429 catalog.summary uses columns that exist", () => {
  it("no longer references the names v413 invented", () => {
    for (const bad of ["min_term_months", "max_term_months"]) {
      expect(src).not.toContain(bad);
    }
  });

  it("uses the real term columns", () => {
    expect(src).toContain("term_min");
    expect(src).toContain("term_max");
    expect(migrations).toContain("term_min");
  });

  it("uses the numeric rate columns, not the TEXT ones", () => {
    expect(src).toContain("rate_min_num");
    expect(src).toContain("rate_max_num");
    expect(migrations).toContain("rate_min_num     NUMERIC");
  });

  it("keeps the amount columns that were already correct", () => {
    expect(src).toContain("min(NULLIF(min_amount, 0))");
    expect(src).toContain("max(NULLIF(max_amount, 0))");
  });
});
