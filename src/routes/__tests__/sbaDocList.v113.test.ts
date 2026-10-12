// BF_SERVER_SBA_DOC_LIST_v113
import { beforeEach, describe, it, expect, vi } from "vitest";
import { computeOutstandingDocs } from "../clientDocumentsNeeded.js";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";
import { docsNeededRules, type DocsNeededFixture } from "../../__tests__/helpers/docsNeededHarness.js";

const { queryMock, sbaContext } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sbaContext: vi.fn(async () => ({ form1919: { q1_debarred: "Yes" }, business: {}, kyc: {} })),
}));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, runQuery: queryMock }));
vi.mock("../../signnow/sba/sbaTrigger.js", () => ({ isSbaApplication: vi.fn(async () => false) }));
vi.mock("../../signnow/sba/sbaOwners.js", () => ({ loadSbaContext: sbaContext }));
vi.mock("../../services/documentSharing.js", () => ({
  shareFromOtherApplications: vi.fn(async () => 0),
  sharedDocumentsFor: vi.fn(async () => []),
}));

const APP = "22222222-3333-4444-8555-666666666666";
const SBA_KEYS = ["sba_form_413", "sba_form_1919", "owner_photo_id", "formation_documents", "personal_tax_returns", "business_plan", "sba_1919_attachments", "debt_schedule", "lease_or_loi"];

async function outstanding(f: DocsNeededFixture) {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql(docsNeededRules(f)));
  return computeOutstandingDocs(APP);
}

describe("generated SBA forms", () => {
  beforeEach(() => sbaContext.mockClear());

  it("413 and 1919 (and the per-owner 413 variants) are generated, not uploadable", async () => {
    const { required } = await outstanding({
      productDocs: ["sba_form_413", "sba_form_1919", "sba_form_413_owner_2", "SBA_FORM_413_OWNER_5", "owner_photo_id"],
    });
    expect(required.map((d) => d.document_type)).toEqual(["owner_photo_id"]);
  });

  it("does not swallow the genuinely uploadable SBA documents", async () => {
    const uploadable = ["sba_1919_attachments", "owner_photo_id", "business_plan", "debt_schedule", "lease_or_loi", "formation_documents", "personal_tax_returns"];
    const { required } = await outstanding({ productDocs: uploadable });
    expect(required.map((d) => d.document_type).sort()).toEqual([...uploadable].sort());
  });

  it("is applied on the wizard-stored list too", async () => {
    const { required } = await outstanding({
      metadata: { productRequirements: { aggregated: [{ document_type: "sba_form_1919", required: true }, { document_type: "business_plan", required: true }] } },
    });
    expect(required.map((d) => d.document_type)).toEqual(["business_plan"]);
  });
});

describe("labels", () => {
  it("no path emits the raw key as the label", async () => {
    const { required } = await outstanding({ productDocs: SBA_KEYS });
    for (const d of required) expect(d.label).not.toBe(d.document_type);
  });

  it("every SBA key has a human label, including the generated forms on the rejected list", async () => {
    const { required, rejected } = await outstanding({
      productDocs: SBA_KEYS,
      uploaded: SBA_KEYS.map((category) => ({ category, status: "rejected" })),
    });
    const labels = new Map([...required, ...rejected].map((d) => [d.document_type, d.label]));
    for (const k of SBA_KEYS) {
      expect(labels.get(k), k).toBeTruthy();
      expect(labels.get(k)).not.toBe(k);
      expect(labels.get(k)).not.toContain("_");
    }
    expect(labels.get("sba_form_413")).toBe("SBA Form 413 - Personal Financial Statement");
    expect(labels.get("business_plan")).toBe("Business plan with financial projections");
  });

  it("falls back to humanize for anything unlisted", async () => {
    const { required } = await outstanding({ productDocs: ["void_cheque", "2 pieces of Government Issued ID"] });
    expect(required.map((d) => d.label)).toEqual(["Void Cheque", "2 pieces of Government Issued ID"]);
  });
});

describe("optional documents", () => {
  it("are no longer dropped from the set", async () => {
    const { required } = await outstanding({ productDocs: [{ document_type: "business_plan", required: false }, "owner_photo_id"] });
    expect(required.map((d) => d.document_type)).toEqual(["business_plan", "owner_photo_id"]);
  });

  it("carry the flag through to the client, and only required ones block", async () => {
    const { required, stillNeeded } = await outstanding({ productDocs: [{ document_type: "business_plan", required: false }, "owner_photo_id"] });
    expect(required).toEqual([
      { document_type: "business_plan", label: "Business plan with financial projections", required: false },
      expect.objectContaining({ document_type: "owner_photo_id", required: true }),
    ]);
    expect(stillNeeded.map((d) => d.document_type)).toEqual(["owner_photo_id"]);
  });
});
