// BF_SERVER_OPTIONAL_DOCS_v138
import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn(), any1919Yes: true }));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.queryMock }, runQuery: h.queryMock, dbQuery: h.queryMock };
});
vi.mock("../../signnow/sba/sbaTrigger.js", async (orig) => ({
  ...(await orig<typeof import("../../signnow/sba/sbaTrigger.js")>()),
  isSbaApplication: vi.fn(async () => false),
}));
vi.mock("../../signnow/sba/sbaOwners.js", async (orig) => ({
  ...(await orig<typeof import("../../signnow/sba/sbaOwners.js")>()),
  loadSbaContext: vi.fn(async () => ({ form1919: { q1_debarred: h.any1919Yes ? "Yes" : "No" }, business: {}, kyc: {} })),
}));
vi.mock("../../services/documentSharing.js", () => ({ shareFromOtherApplications: vi.fn(async () => 0), sharedDocumentsFor: vi.fn(async () => []) }));

const v114 = readFileSync(
  resolve(__dirname, "..", "..", "..", "migrations", "2026_08_26_v114_sba_doc_set_trimmed.sql"), "utf-8");

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REQUIREMENTS = [
  { document_type: "business_plan", required: true },
  { document_type: "Lease agreement", required: false },
  { document_type: "lease_or_loi" },
  { document_type: "sba_1919_attachments", required: false },
  { document_type: "Void cheque" },
];

function answers(uploaded: Array<{ category: string; status: string }>) {
  return answerBySql([
    [/WITH fam AS/, { rows: uploaded }],
    [/SELECT metadata FROM applications/, { rows: [{ metadata: { productRequirements: { aggregated: REQUIREMENTS } } }] }],
  ]);
}

beforeEach(() => { h.queryMock.mockReset(); h.any1919Yes = true; });

describe("the data already said these are optional", () => {
  it.each(["sba_1919_attachments", "lease_or_loi"])("%s is required=false in the migration", (doc) => {
    expect(v114).toContain(doc);
  });

  it("v114 marked them false rather than deleting them", () => {
    expect(v114).toContain("'sba_1919_attachments', false");
    expect(v114).toContain("'lease_or_loi',         false");
  });
});

describe("an optional document no longer blocks", () => {
  it("stillNeeded excludes anything flagged required:false, and returns all three buckets", async () => {
    h.queryMock.mockImplementation(answers([]));
    const { computeOutstandingDocs } = await import("../clientDocumentsNeeded.js");
    const out = await computeOutstandingDocs(APP_ID);
    expect(Object.keys(out).sort()).toEqual(["rejected", "required", "stillNeeded"]);
    expect(out.stillNeeded.map((d) => d.document_type)).not.toContain("Lease agreement");
    expect(out.stillNeeded.map((d) => d.document_type)).not.toContain("lease_or_loi");
  });

  it("uses !== false, so an absent flag still means required", async () => {
    // Legacy rows have no flag at all. Defaulting those to optional would let a
    // genuinely mandatory document through.
    h.queryMock.mockImplementation(answers([]));
    const { computeOutstandingDocs } = await import("../clientDocumentsNeeded.js");
    const out = await computeOutstandingDocs(APP_ID);
    expect(out.stillNeeded.map((d) => d.document_type)).toContain("Void cheque");
    expect(out.required.find((d) => d.document_type === "Void cheque")?.required).toBe(true);
  });

  it("keeps optional items in the full required set for staff", async () => {
    h.queryMock.mockImplementation(answers([]));
    const { computeOutstandingDocs } = await import("../clientDocumentsNeeded.js");
    const out = await computeOutstandingDocs(APP_ID);
    const flags = Object.fromEntries(out.required.map((d) => [d.document_type, d.required]));
    expect(flags).toMatchObject({ business_plan: true, "Lease agreement": false, lease_or_loi: false, "Void cheque": true });
  });
});

describe("why it mattered", () => {
  async function taskStatus(uploaded: Array<{ category: string; status: string }>) {
    h.any1919Yes = false;
    const docRule = answers(uploaded);
    h.queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (/SELECT DISTINCT cta_action, max\(cta_label\)/.test(text)) return { rows: [{ cta_action: "upload_docs", cta_label: "Upload documents" }] };
      return docRule(sql, params);
    });
    const router = (await import("../../modules/applications/applications.routes.js")).default;
    const { errorHandler } = await import("../../middleware/errors.js");
    const app = express();
    app.use(express.json());
    app.use("/api/applications", router);
    app.use(errorHandler);
    const token = jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
    const res = await request(app).get(`/api/applications/${APP_ID}/task-status`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body.tasks.find((t: any) => t.key === "upload_docs");
  }

  it("stillNeeded gates whether the whole application is clear: optional items left out do not hold it", async () => {
    const t = await taskStatus([{ category: "business_plan", status: "accepted" }, { category: "Void cheque", status: "uploaded" }]);
    expect(t.complete).toBe(true);
  });

  it("a missing blocking document still holds it", async () => {
    const t = await taskStatus([{ category: "business_plan", status: "accepted" }]);
    expect(t.complete).toBe(false);
  });

  it("the two conditional SBA docs are still labelled for the applicant", async () => {
    h.queryMock.mockImplementation(answers([]));
    const { computeOutstandingDocs } = await import("../clientDocumentsNeeded.js");
    const out = await computeOutstandingDocs(APP_ID);
    const labels = Object.fromEntries(out.required.map((d) => [d.document_type, d.label]));
    expect(labels.sba_1919_attachments).toBe("Supporting detail for any Yes answer on Form 1919");
    expect(labels.lease_or_loi).toContain("only if the loan involves premises");
  });
});
