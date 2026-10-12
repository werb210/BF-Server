// BF_SERVER_LEASE_OPTIONAL_v752 / BF_SERVER_SBA_FORMS_SCOPE_v752 / BF_SERVER_SEND_REASON_v752 / BF_SERVER_SBA_LOG_ONCE_v752
import express from "express";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import { computeOutstandingDocs, isAlwaysOptionalDoc } from "../routes/clientDocumentsNeeded.js";
import { shouldLogBlocked } from "../signnow/sba/sbaSigning.js";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { docsNeededRules, wizardRequirements } from "./helpers/docsNeededHarness.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query: queryMock }, runQuery: queryMock, dbQuery: queryMock }));
vi.mock("../signnow/sba/sbaTrigger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../signnow/sba/sbaTrigger.js")>()),
  isSbaApplication: vi.fn(async () => false),
}));
vi.mock("../signnow/sba/sbaPackageReadiness.js", () => ({ sbaPackageBlocker: vi.fn(async () => null) }));
vi.mock("../services/documentSharing.js", () => ({
  shareFromOtherApplications: vi.fn(async () => 0),
  sharedDocumentsFor: vi.fn(async () => []),
}));

const APP = "55555555-6666-4777-8888-999999999999";

describe("lease or letter of intent is optional", () => {
  it("by key or by its label, from any list", () => {
    expect(isAlwaysOptionalDoc("lease_or_loi")).toBe(true);
    expect(isAlwaysOptionalDoc("Lease or letter of intent - only if the loan involves premises")).toBe(true);
    expect(isAlwaysOptionalDoc("owner_photo_id")).toBe(false);
    expect(isAlwaysOptionalDoc("Lease agreement (if applicable)")).toBe(false);
  });
  it("is optional even when the wizard's list stored it as required", async () => {
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql(docsNeededRules({ metadata: wizardRequirements([{ document_type: "lease_or_loi", required: true }, "owner_photo_id"]) })));
    const out = await computeOutstandingDocs(APP);
    expect(out.required.find((d) => d.document_type === "lease_or_loi")?.required).toBe(false);
    expect(out.stillNeeded.map((d) => d.document_type)).toEqual(["owner_photo_id"]);
  });
  it("stays required when staff request it from Request Items", async () => {
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql(docsNeededRules({ productDocs: ["owner_photo_id"], requested: ["lease_or_loi"] })));
    const out = await computeOutstandingDocs(APP);
    expect(out.required.find((d) => d.document_type === "lease_or_loi")).toMatchObject({ required: true });
    expect(out.stillNeeded.map((d) => d.document_type)).toContain("lease_or_loi");
  });
});

describe("SBA forms list is scoped to the application", () => {
  it("takes the product category from the application when only application_id is sent", async () => {
    queryMock.mockReset();
    queryMock.mockImplementation(
      answerBySql([
        [/SELECT product_category FROM applications WHERE id::text = \(\$1\)::text LIMIT 1/, { rows: [{ product_category: "SBA_GOVERNMENT" }] }],
        [/information_schema\.columns/, { rows: [{ column_name: "required_documents" }, { column_name: "category" }] }],
        [/SELECT id, required_documents FROM lender_products/, { rows: [{ id: "p1", required_documents: ["business_plan"] }] }],
      ]),
    );
    const app = express();
    app.use("/api/portal", (await import("../routes/lenderProductsRequiredDocs.js")).default);
    const res = await request(app).get("/api/portal/lender-products/required-docs").query({ application_id: APP });
    expect(res.status).toBe(200);
    expect(callsMatching(queryMock, /SELECT product_category FROM applications/)[0]![1]).toEqual([APP]);
    // The long-form category is normalized to the column's short code before filtering.
    const products = callsMatching(queryMock, /SELECT id, required_documents FROM lender_products/);
    expect(String(products[0]![0])).toContain("lower(category) = $1");
    expect(products[0]![1]).toEqual(["sba"]);
  });
});

describe("send says what is missing", () => {
  async function sendReason(app: { signnow_app_signed_at: string | null; credit_summary_completed_at: string | null; requested_amount: number }) {
    queryMock.mockReset();
    queryMock.mockImplementation(
      answerBySql([
        [/SELECT credit_summary_completed_at, signnow_app_signed_at, requested_amount FROM applications/, { rows: [app] }],
        ...docsNeededRules({}),
      ]),
    );
    const { maybeBuildAndSendPackage } = await import("../services/submission/orchestrator.js");
    return maybeBuildAndSendPackage({ pool: { query: queryMock } as any, applicationId: APP });
  }
  it("separate reasons for an unsigned application and an unsubmitted credit summary", async () => {
    expect(await sendReason({ signnow_app_signed_at: null, credit_summary_completed_at: null, requested_amount: 900_000 })).toEqual({ fired: false, reason: "application_not_signed" });
    expect(await sendReason({ signnow_app_signed_at: "2026-10-01", credit_summary_completed_at: null, requested_amount: 900_000 })).toEqual({ fired: false, reason: "credit_summary_not_submitted" });
    expect(callsMatching(queryMock, /SET submission_packages_started_at = NOW\(\)/)).toHaveLength(0);
  });
});

describe("blocked SBA dispatch is logged once per six hours", () => {
  it("throttles by application and owner", () => {
    expect(shouldLogBlocked("a:1", 1_000)).toBe(true);
    expect(shouldLogBlocked("a:1", 1_000 + 5 * 60_000)).toBe(false);
    expect(shouldLogBlocked("a:2", 1_000)).toBe(true);
    expect(shouldLogBlocked("a:1", 1_000 + 6 * 3_600_000 + 1)).toBe(true);
  });
});

// BF_SERVER_SIGNED_APP_FILED_v752
import { fileSignedApplicationDocument } from "../signnow/finalizeSignedApplication.js";
describe("the signed application is filed under Documents", () => {
  const stored = { blobName: "app/signed.pdf", url: "https://blob/app/signed.pdf", sizeBytes: 1234, hash: "abc" };
  it("inserts one accepted system document", async () => {
    const inserts: unknown[][] = [];
    const q = async (sql: string, params: unknown[]) => {
      if (/^\s*SELECT id::text AS id FROM documents/.test(sql)) return { rows: [] };
      if (/INSERT INTO documents/.test(sql)) { inserts.push(params); return { rows: [] }; }
      throw new Error("unexpected sql " + sql);
    };
    expect(await fileSignedApplicationDocument("app-1", stored, q)).toEqual({ filed: true });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual(expect.arrayContaining(["app-1", "Signed-Application-app-1.pdf", "abc", "app/signed.pdf", 1234, "signed_application"]));
  });
  it("does not file it twice", async () => {
    const q = async (sql: string) => (/SELECT id::text AS id FROM documents/.test(sql) ? { rows: [{ id: "d1" }] } : (() => { throw new Error("no insert expected"); })());
    expect(await fileSignedApplicationDocument("app-1", stored, q as any)).toEqual({ filed: false, reason: "already_filed" });
  });
});
