import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const staff = readFileSync(fileURLToPath(new URL("../routes/mayaStaff.ts", import.meta.url)), "utf-8");
const proxy = readFileSync(fileURLToPath(new URL("../routes/maya.ts", import.meta.url)), "utf-8");

describe("maya lender-products live-schema fix", () => {
  it("no longer selects columns that do not exist on lender_products", () => {
    expect(staff).not.toContain("lp.region");
    expect(staff).not.toContain("lp.term_min");
    expect(staff).not.toContain("lp.term_max");
    expect(staff).not.toContain("lp.term_unit");
  });
  it("still returns the real product economics", () => {
    expect(staff).toContain("lp.interest_min, lp.interest_max");
    expect(staff).toContain("lp.amount_min, lp.amount_max");
  });
  it("guards transcript persistence to valid uuid session ids", () => {
    expect(proxy).toContain("isUuidSession");
    expect(proxy).toContain("if (sessionId && userMsg && isUuidSession)");
  });
});
