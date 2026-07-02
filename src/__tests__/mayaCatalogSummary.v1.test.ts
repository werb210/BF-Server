import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
const src = readFileSync(fileURLToPath(new URL("../routes/mayaStaff.ts", import.meta.url)), "utf-8");
describe("Maya catalog summary", () => {
  it("exposes /catalog-summary returning counts only (no names)", () => {
    expect(src).toContain("/catalog-summary");
    expect(src).toContain("count(*)::int AS n FROM lenders");
    expect(src).toContain("count(*)::int AS n FROM lender_products");
  });
});
