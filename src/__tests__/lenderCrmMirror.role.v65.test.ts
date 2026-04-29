// BF_SERVER_v65_LENDER_MIRROR_ROLE
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_v65_LENDER_MIRROR_ROLE", () => {
  const src = readFileSync(join(__dirname, "..", "services", "lenderCrmMirror.ts"), "utf8");
  it("anchor present", () => { expect(src.includes("BF_SERVER_v65_LENDER_MIRROR_ROLE")).toBe(true); });
  it("no longer uses 'lender_primary' in SQL (comment mention is allowed)", () => {
    const codeOnly = src.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
    expect(codeOnly.includes("'lender_primary'")).toBe(false);
  });
  it("INSERT writes role='other' for the lender contact", () => {
    expect(src).toMatch(/'lender', 'other', now\(\), now\(\)/);
  });
  it("dedupe predicates use lifecycle_stage='lender' instead of role", () => {
    const matches = src.match(/lifecycle_stage = 'lender'/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
