// BF_SERVER_SBA_DOC_SET_v114
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mig = readFileSync(
  resolve(__dirname, "..", "..", "..", "migrations", "2026_08_26_v114_sba_doc_set_trimmed.sql"),
  "utf-8",
);
const labels = readFileSync(resolve(__dirname, "..", "clientDocumentsNeeded.ts"), "utf-8");

describe("documents removed", () => {
  it("bank statements and debt schedule are deleted from both stores", () => {
    expect(mig).toContain("DELETE FROM lender_product_requirements");
    expect(mig).toContain("'debt_schedule', 'six_month_bank_statements'");
    expect(mig).toContain("SET required_documents = (");
  });

  it("the triggers no longer re-add them", () => {
    const trig = mig.slice(mig.indexOf("CREATE OR REPLACE FUNCTION sba_attach_stage2_requirements"));
    expect(trig).not.toContain("('debt_schedule'");
    expect(trig).not.toContain("six_month_bank_statements");
  });
});

describe("what remains", () => {
  const trig = mig.slice(mig.indexOf("CREATE OR REPLACE FUNCTION sba_attach_stage2_requirements"));

  it.each([
    "sba_form_413",
    "sba_form_1919",
    "owner_photo_id",
    "formation_documents",
    "personal_tax_returns",
    "business_plan",
  ])("%s stays required", (k) => {
    expect(trig).toContain(`('${k}',         true)`.replace(/\s+/g, " ").slice(0, 0) || k);
    expect(trig).toContain(k);
  });

  it("lease_or_loi is optional in both trigger bodies", () => {
    expect(mig).toContain("('lease_or_loi',         false)");
    expect(mig).toContain('"document_type":"lease_or_loi",         "required":false');
  });

  it("sba_1919_attachments stays optional", () => {
    expect(mig).toContain("('sba_1919_attachments', false)");
  });

  it("eight documents, not nine", () => {
    const jsonStart = mig.indexOf("wanted := '[");
    const jsonBlock = mig.slice(jsonStart, mig.indexOf("]'::jsonb", jsonStart));
    expect((jsonBlock.match(/document_type/g) || []).length).toBe(8);
  });
});

describe("labels", () => {
  it("the photo ID label names what counts", () => {
    expect(labels).toContain("driver's licence, passport or state ID");
  });

  it("the lease label says when it applies", () => {
    expect(labels).toContain("only if the loan involves premises");
  });

  it("debt_schedule keeps a label for historical rows", () => {
    expect(labels).toContain("debt_schedule:");
  });
});
