// CRM_CLEANUP_INITIALS_v1 - initials keep their capitals in "Clean up data".
import { describe, expect, it } from "vitest";
import { properCasePersonName, proposeContactFixes } from "../textClean.js";

describe("initials", () => {
  it("R.J. and JP are kept; whole names still proper-case", () => {
    expect(properCasePersonName("R.J.")).toBe("R.J.");
    expect(properCasePersonName("JP")).toBe("JP");
    expect(properCasePersonName("JOHN SMITH")).toBe("John Smith");
    expect(proposeContactFixes({ first_name: "JP", last_name: "Prinz" })).toEqual([]);
  });
});
