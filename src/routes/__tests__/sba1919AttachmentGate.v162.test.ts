// BF_SERVER_SBA_1919_ATTACH_GATE_v162
import { describe, it, expect } from "vitest";
import { any1919QuestionYes, gate1919Attachment } from "../clientDocumentsNeeded";

const NO_FORM = {
  q1_debarred: "No", q2_federal_default: "No", q3_other_business: "No",
  q5_exports: "No", q6_broker_fee: "No", q7_restricted_revenue: "No",
  q8_sba_employee: "No", q9_former_sba: "No", q10_congress: "No",
  q11_federal_employee: "No", q12_advisory_council: "No", q13_legal_action: "No",
};

describe("any1919QuestionYes (gate decision)", () => {
  it("is false when every answer is No", () => {
    expect(any1919QuestionYes(NO_FORM, {}, {})).toBe(false);
  });

  it("is false when the form is empty / unanswered", () => {
    expect(any1919QuestionYes({}, {}, {})).toBe(false);
    expect(any1919QuestionYes(null, null, null)).toBe(false);
  });

  it("is true when any single form question is Yes", () => {
    for (const key of Object.keys(NO_FORM)) {
      expect(any1919QuestionYes({ ...NO_FORM, [key]: "Yes" }, {}, {})).toBe(true);
    }
  });

  it("is true when Q4 (criminal history) is Yes from business or kyc metadata", () => {
    expect(any1919QuestionYes(NO_FORM, { sbaQ4Criminal: "Yes" }, {})).toBe(true);
    expect(any1919QuestionYes(NO_FORM, {}, { sbaQ4Criminal: "Yes" })).toBe(true);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(any1919QuestionYes({ ...NO_FORM, q7_restricted_revenue: " yes " }, {}, {})).toBe(true);
    expect(any1919QuestionYes({ ...NO_FORM, q7_restricted_revenue: "YES" }, {}, {})).toBe(true);
  });

  it("does not treat non-yes truthy values as Yes", () => {
    expect(any1919QuestionYes({ ...NO_FORM, q1_debarred: true }, {}, {})).toBe(false);
    expect(any1919QuestionYes({ ...NO_FORM, q1_debarred: "y" }, {}, {})).toBe(false);
  });
});

const ATTACH = { document_type: "sba_1919_attachments", label: "x", required: true };
const OTHER = { document_type: "personal_tax_returns", label: "y", required: true };

describe("gate1919Attachment (gate application)", () => {
  it("REMOVES the attachment entirely when no answer is Yes", () => {
    const out = gate1919Attachment([{ ...ATTACH }, { ...OTHER }], false);
    expect(out.map((d) => d.document_type)).toEqual(["personal_tax_returns"]);
  });

  it("KEEPS the attachment and marks it blocking when an answer is Yes", () => {
    const out = gate1919Attachment([{ ...ATTACH, required: undefined as any }, { ...OTHER }], true);
    const hit = out.find((d) => d.document_type === "sba_1919_attachments");
    expect(hit).toBeTruthy();
    expect(hit?.required).toBe(true);
  });

  it("is a no-op when the attachment is not in the set (non-SBA file)", () => {
    const out = gate1919Attachment([{ ...OTHER }], false);
    expect(out.map((d) => d.document_type)).toEqual(["personal_tax_returns"]);
    const out2 = gate1919Attachment([{ ...OTHER }], true);
    expect(out2.map((d) => d.document_type)).toEqual(["personal_tax_returns"]);
  });

  it("matches the key case-insensitively / with surrounding space", () => {
    const out = gate1919Attachment([{ document_type: " SBA_1919_Attachments ", label: "x" }], false);
    expect(out).toHaveLength(0);
  });
});
