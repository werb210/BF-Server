// BF_SERVER_SBA_STAGE2_REACHABLE_v101
import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  owners: [] as Array<{ index: number }>,
  ownersError: null as Error | null,
}));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("../../signnow/sba/sbaOwners.js", async (orig) => ({
  ...(await orig<typeof import("../../signnow/sba/sbaOwners.js")>()),
  resolveSbaOwners: vi.fn(async () => { if (h.ownersError) throw h.ownersError; return h.owners; }),
}));
vi.mock("../../signnow/sba/sbaTrigger.js", async (orig) => ({
  ...(await orig<typeof import("../../signnow/sba/sbaTrigger.js")>()),
  isSbaApplication: vi.fn(async () => true),
}));

const migSrc = readFileSync(resolve(__dirname, "..", "..", "..", "migrations", "2026_08_26_v101_sba_docs_into_product_json.sql"), "utf-8");
const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function requiredDocs() {
  h.query.mockImplementation(answerBySql([
    [/FROM information_schema\.columns/, { rows: [{ column_name: "required_documents" }, { column_name: "category" }] }],
    [/SELECT id, required_documents FROM lender_products/, { rows: [{ id: "p1", required_documents: [
      { document_type: "sba_form_413", required: true, stage: 2 },
      { document_type: "sba_form_1919", required: true, stage: 2 },
      { document_type: "business_plan", required: true },
    ] }] }],
  ]));
  const router = (await import("../lenderProductsRequiredDocs.js")).default;
  const app = express();
  app.use("/api/portal", router);
  const res = await request(app).get(`/api/portal/lender-products/required-docs?application_id=${APP_ID}&product_category=SBA_GOVERNMENT`);
  expect(res.status).toBe(200);
  return (res.body.items as Array<{ document_type: string; stage: number }>);
}

beforeEach(() => { h.query.mockReset(); h.owners = []; h.ownersError = null; });

describe("SBA Stage 2 reachability", () => {
  it("expands Form 413 per owner while preserving owner one's key", async () => {
    h.owners = [{ index: 1 }, { index: 2 }, { index: 3 }];
    const keys = (await requiredDocs()).map((i) => i.document_type);
    expect(keys).toEqual(["business_plan", "sba_form_1919", "sba_form_413", "sba_form_413_owner_2", "sba_form_413_owner_3"]);
    expect(keys).not.toContain("sba_form_413_owner_1");
  });

  it("a single owner keeps the one Form 413", async () => {
    h.owners = [{ index: 1 }];
    const keys = (await requiredDocs()).map((i) => i.document_type);
    expect(keys.filter((k) => k.startsWith("sba_form_413"))).toEqual(["sba_form_413"]);
  });

  it("does not blank the list after owner resolution failure", async () => {
    h.ownersError = new Error("owners unavailable");
    const keys = (await requiredDocs()).map((i) => i.document_type);
    expect(keys).toEqual(["business_plan", "sba_form_1919", "sba_form_413"]);
  });

  it("mirrors every SBA requirement into product JSON", () => {
    expect(migSrc).toContain("required_documents");
    for (const key of ["sba_form_413", "sba_form_1919", "owner_photo_id", "formation_documents", "personal_tax_returns", "business_plan", "sba_1919_attachments", "debt_schedule", "lease_or_loi"]) {
      expect(migSrc).toContain(key);
    }
  });

  it("uses an idempotent BEFORE trigger", () => {
    expect(migSrc).toContain("BEFORE INSERT OR UPDATE OF type ON lender_products");
    expect(migSrc).toContain("h->>'document_type', h->>'category'");
  });
});
