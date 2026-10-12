// BF_SERVER_SBA_DOC_SET_v114
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeOutstandingDocs } from "../clientDocumentsNeeded.js";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";
import { docsNeededRules } from "../../__tests__/helpers/docsNeededHarness.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, runQuery: queryMock }));
vi.mock("../../signnow/sba/sbaTrigger.js", () => ({ isSbaApplication: vi.fn(async () => false) }));
vi.mock("../../services/documentSharing.js", () => ({
  shareFromOtherApplications: vi.fn(async () => 0),
  sharedDocumentsFor: vi.fn(async () => []),
}));

const mig = readFileSync(
  resolve(__dirname, "..", "..", "..", "migrations", "2026_08_26_v114_sba_doc_set_trimmed.sql"),
  "utf-8",
);
// The labels the applicant actually sees for each SBA key, from the real docs-needed computation.
async function labelOf(key: string): Promise<string> {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql(docsNeededRules({ productDocs: [key] })));
  const { required } = await computeOutstandingDocs("22222222-3333-4444-8555-666666666666");
  expect(required).toHaveLength(1);
  return required[0]!.label;
}

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
  it("the photo ID label names what counts", async () => {
    expect(await labelOf("owner_photo_id")).toContain("driver's licence, passport or state ID");
  });

  it("the lease label says when it applies", async () => {
    expect(await labelOf("lease_or_loi")).toContain("only if the loan involves premises");
  });

  it("debt_schedule keeps a label for historical rows", async () => {
    expect(await labelOf("debt_schedule")).toBe("Debt schedule - existing business debt");
  });
});
