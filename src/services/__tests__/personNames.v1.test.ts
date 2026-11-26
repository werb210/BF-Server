// BF_SERVER_PERSON_NAMES_v1 - titles and placeholders in the name column are never treated as a person's name.
import { describe, expect, it } from "vitest";
import { isTitle, splitNameTitle } from "../directory/personName.js";

describe("splitNameTitle", () => {
  it("moves a title out of the name column", () => {
    expect(splitNameTitle("Dir.", null)).toEqual({ name: null, title: "Dir." });
    expect(splitNameTitle("Field Exmr.", "")).toEqual({ name: null, title: "Field Exmr." });
    expect(splitNameTitle("Senior Vice President", "SVP")).toEqual({ name: null, title: "SVP" });
    expect(splitNameTitle("Southeast Reg. Mgr. - ABL", null)).toEqual({ name: null, title: "Southeast Reg. Mgr. - ABL" });
  });
  it("drops placeholders", () => {
    for (const p of ["(general inbox)", "(name not found)", "(commercial loans inbox)", "www.Bangor.com/business", "info@x.com"]) {
      expect(splitNameTitle(p, null).name).toBeNull();
    }
  });
  it("splits Name, Title and keeps real names", () => {
    expect(splitNameTitle("Susan Lamping, Vice President of Sales", null)).toEqual({ name: "Susan Lamping", title: "Vice President of Sales" });
    expect(splitNameTitle("Brian Center", "VP")).toEqual({ name: "Brian Center", title: "VP" });
    expect(splitNameTitle("Smith, John", null).name).toBe("Smith, John");
    expect(splitNameTitle("Mark Smith", null).name).toBe("Mark Smith");
  });
});


