// BF_SERVER_SBA_V103
import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import { answerBySql } from "../../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  configured: true,
  owners: [] as Array<{ index: number }>,
  ownersError: null as Error | null,
  envelopes: [] as Array<Record<string, unknown>>,
  signed: true,
  logInfo: vi.fn(),
}));
vi.mock("../../../db", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("../../signnowClient.js", async (orig) => ({
  ...(await orig<typeof import("../../signnowClient.js")>()),
  isApiKeyConfigured: () => h.configured,
  getDocumentGroupStatus: vi.fn(async () => ({ signed: h.signed })),
}));
vi.mock("../sbaOwners.js", async (orig) => ({
  ...(await orig<typeof import("../sbaOwners.js")>()),
  resolveSbaOwners: vi.fn(async () => { if (h.ownersError) throw h.ownersError; return h.owners; }),
}));
vi.mock("../sbaTrigger.js", async (orig) => ({
  ...(await orig<typeof import("../sbaTrigger.js")>()),
  isSbaApplication: vi.fn(async () => true),
}));
vi.mock("../../../observability/logger.js", async (orig) => ({
  ...(await orig<typeof import("../../../observability/logger.js")>()),
  logInfo: h.logInfo,
}));

const mig = readFileSync(resolve(__dirname, "..", "..", "..", "..", "migrations", "2026_08_26_v103_sba_docs_into_product_json.sql"), "utf-8");

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SBA_KEYS = [
  "sba_form_413", "sba_form_1919", "owner_photo_id", "formation_documents",
  "personal_tax_returns", "business_plan", "sba_1919_attachments",
  "debt_schedule", "lease_or_loi",
];
const envelope = (ownerIndex: number) => ({ ownerIndex, email: `o${ownerIndex}@x.com`, groupId: `g${ownerIndex}`, inviteId: "i", docIds: [], ives4506cLenderIds: ["l1"], createdAt: new Date().toISOString() });

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([[/SELECT metadata FROM applications/, () => ({ rows: [{ metadata: { sba_signnow: h.envelopes } }] })]]));
  h.configured = true; h.owners = [{ index: 1 }, { index: 2 }]; h.ownersError = null; h.envelopes = []; h.signed = true;
  h.logInfo.mockClear();
});

const logged = (event: string) => h.logInfo.mock.calls.some((c: unknown[]) => c[0] === event);

describe("Stage 2 reachability", () => {
  it("mirrors the SBA set into the jsonb column the route reads", () => {
    for (const k of SBA_KEYS) expect(mig).toContain(k);
    expect(mig).toContain("required_documents");
  });
  it("merges BEFORE the row is written", () => {
    expect(mig).toContain("BEFORE INSERT OR UPDATE OF type ON lender_products");
  });
  it("is idempotent across both field spellings", () => {
    expect(mig).toContain("h->>'document_type', h->>'category'");
  });
  it("expands Form 413 per owner", async () => {
    h.owners = [{ index: 1 }, { index: 2 }];
    h.query.mockImplementation(answerBySql([
      [/FROM information_schema\.columns/, { rows: [{ column_name: "required_documents" }] }],
      [/SELECT id, required_documents FROM lender_products/, { rows: [{ id: "p1", required_documents: ["sba_form_413"] }] }],
    ]));
    const router = (await import("../../../routes/lenderProductsRequiredDocs.js")).default;
    const app = express();
    app.use("/api/portal", router);
    const res = await request(app).get(`/api/portal/lender-products/required-docs?application_id=${APP_ID}`);
    expect(res.body.items.map((i: any) => i.document_type)).toEqual(["sba_form_413", "sba_form_413_owner_2"]);
  });
});

describe("dispatch gate", () => {
  const gate = async () => (await import("../sbaSigning.js")).sbaSigningSatisfiedForDispatch(APP_ID);

  it("answers to the owner list, not the envelope list", async () => {
    // Owner 2 was skipped (no email), so only owner 1 has a signed envelope.
    h.envelopes = [envelope(1)];
    expect(await gate()).toBe(false);
    expect(logged("sba_dispatch_blocked_missing_envelope")).toBe(true);
    h.envelopes = [envelope(1), envelope(2)];
    expect(await gate()).toBe(true);
  });

  it("no longer passes an empty envelope list", async () => {
    h.envelopes = [];
    expect(await gate()).toBe(false);
  });

  it("refuses dispatch when no owners resolve", async () => {
    h.owners = [];
    h.envelopes = [envelope(1)];
    expect(await gate()).toBe(false);
    h.ownersError = new Error("owners unavailable");
    expect(await gate()).toBe(false);
  });

  it("an unsigned envelope still holds the package", async () => {
    h.envelopes = [envelope(1), envelope(2)];
    h.signed = false;
    expect(await gate()).toBe(false);
  });

  it("keeps the unconfigured-SignNow escape so non-prod is unaffected", async () => {
    h.configured = false;
    h.owners = [];
    expect(await gate()).toBe(true);
  });

  it("logs rather than silently thinning the package", async () => {
    h.envelopes = [];
    const { getSignedSbaPdfs } = await import("../sbaSigning.js");
    expect(await getSignedSbaPdfs(APP_ID)).toEqual([]);
    expect(h.logInfo).toHaveBeenCalledWith("sba_signed_pdfs_none_available", { applicationId: APP_ID });
  });
});
