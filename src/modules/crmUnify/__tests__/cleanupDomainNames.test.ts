// A name that is really a web address is not "fixed" by capitalising it.
import { describe, expect, it } from "vitest";
import { looksLikeDomain, proposeCompanyFixes, proposeContactFixes } from "../textClean.js";

describe("clean-up and names that are web addresses", () => {
  it("knows a web address from a name", () => {
    for (const v of ["virgohome.io", "walter.ca", "north6ixmanagement.com", "gov.ab.ca"]) expect(looksLikeDomain(v)).toBe(true);
    for (const v of ["TEST COMPANY", "acme lending inc.", "st. john", "j. smith"]) expect(looksLikeDomain(v)).toBe(false);
  });
  it("leaves a company named by its web address alone, and still fixes real names", () => {
    expect(proposeCompanyFixes({ name: "virgohome.io" }).filter((p) => p.field === "name")).toEqual([]);
    expect(proposeCompanyFixes({ name: "TEST COMPANY" }).find((p) => p.field === "name")?.after).toBe("Test Company");
  });
  it("does the same for a contact field", () => {
    expect(proposeContactFixes({ company_name: "walter.ca", first_name: "george" }).some((p) => String(p.after).startsWith("Walter"))).toBe(false);
  });
});
