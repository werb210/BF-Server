// BF_SERVER_v807_FORM_DOCS - a lender-required PNW / debt stack / equipment / real estate / advisors item is a
// form in the client's to-do list, never a file to upload; CRA and bank connection appear only when requested.
import { describe, expect, it } from "vitest";
import { assembleActionCenter, formForDocType } from "../applicantActions.js";

const base = { requestedForms: [] as string[], waivedForms: [] as string[], submittedFormTypes: [] as string[], required: [], stillNeeded: [], rejected: [] };

describe("v807 forms that lenders require", () => {
  it("lists a required PNW as the form, marked outstanding, not as an upload", () => {
    const c = assembleActionCenter({ ...base, required: [{ document_type: "personal_net_worth", label: "Personal net worth statement" }], stillNeeded: [{ document_type: "personal_net_worth", label: "Personal net worth statement" }] });
    expect(c.outstanding.map((i) => i.key)).toEqual(["form:networth"]);
    expect(c.outstanding[0]?.kind).toBe("form");
  });
  it("counts it done once the form is submitted", () => {
    const c = assembleActionCenter({ ...base, required: [{ document_type: "net_worth_statement", label: "PNW" }], submittedFormTypes: ["net_worth_statement"] });
    expect(c.outstanding).toEqual([]);
    expect(c.completed.map((i) => i.key)).toEqual(["form:networth"]);
  });
  it("maps the other form documents, and never CRA or bank connection", () => {
    expect(["debt_stack", "equipment_list", "real_estate_schedule", "professional_advisors"].map(formForDocType)).toEqual(["debt", "equipment", "realestate", "advisors"]);
    expect(formForDocType("cra_view_only_authorization")).toBeNull();
    expect(formForDocType("flinks_banking")).toBeNull();
    expect(formForDocType("bank_statements")).toBeNull();
  });
  it("keeps real documents as uploads", () => {
    const c = assembleActionCenter({ ...base, required: [{ document_type: "bank_statements", label: "Bank statements" }], stillNeeded: [{ document_type: "bank_statements", label: "Bank statements" }] });
    expect(c.outstanding.map((i) => i.key)).toEqual(["upload:bank_statements"]);
  });
});
