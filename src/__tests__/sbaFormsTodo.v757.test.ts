// BF_SERVER_SBA_FORMS_TODO_v757
import { describe, it, expect } from "vitest";
import { assembleActionCenter } from "../services/applicantActions.js";

const base = { requestedForms: ["networth", "debt"], waivedForms: [], required: [], stillNeeded: [], rejected: [] };

describe("SBA forms on the client's to-do list", () => {
  it("an SBA deal lists Form 1919 and a 413 per owner, and Form 413 replaces Personal Net Worth", () => {
    const c = assembleActionCenter({ ...base, submittedFormTypes: [], sbaOwners: [{ index: 1, name: "Brandon Voss" }, { index: 2, name: "Pat Partner" }] });
    const labels = c.outstanding.map((i) => i.label);
    expect(labels).toContain("SBA Form 1919 - Borrower Information");
    expect(labels).toContain("SBA Form 413 - Personal Financial Statement - Brandon Voss");
    expect(labels).toContain("SBA Form 413 - Personal Financial Statement - Pat Partner");
    expect(labels).not.toContain("Personal Net Worth");
    expect(labels).toContain("Debt Stack");
    expect(c.outstanding.find((i) => i.key === "form:sba_form_413_owner_2")?.action).toBe("sba_forms");
  });
  it("one owner: no name on the line; submitted forms move to done", () => {
    const c = assembleActionCenter({ ...base, submittedFormTypes: ["sba_form_413"], sbaOwners: [{ index: 1, name: "Brandon Voss" }] });
    expect(c.completed.map((i) => i.label)).toContain("SBA Form 413 - Personal Financial Statement");
    expect(c.outstanding.map((i) => i.key)).toContain("form:sba_form_1919");
  });
  it("a non-SBA deal is unchanged", () => {
    const c = assembleActionCenter({ ...base, submittedFormTypes: [] });
    const labels = c.outstanding.map((i) => i.label);
    expect(labels).toContain("Personal Net Worth");
    expect(labels.some((l) => l.startsWith("SBA Form"))).toBe(false);
  });
});
