// BF_SERVER_BI_DOC_COPY_v701
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  linked: true,
  files: {} as Record<string, Buffer>,
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  backfillRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../db.js", () => {
  const query = async (sql: string, params: unknown[] = []) => {
    state.queries.push({ sql, params });
    if (sql.includes("FROM documents d JOIN applications a") && sql.includes("bi_public_id IS NOT NULL")) {
      if (!state.linked || params[0] !== "11111111-1111-4111-8111-111111111111") return { rows: [] };
      return { rows: [{ filename: "Statements June 2026.pdf", title: null, storage_key: null, blob_name: "docs/june.pdf", storage_path: null }] };
    }
    if (sql.includes("WHERE a.bi_public_id IS NOT NULL") && sql.includes("FROM documents d")) return { rows: state.backfillRows };
    if (sql.includes("SELECT bi_public_id FROM applications")) return { rows: [{ bi_public_id: "BI-PUB" }] };
    if (/SELECT id, silo, owner_user_id\s+FROM applications/.test(sql)) {
      return { rows: [{ id: "11111111-1111-4111-8111-111111111111", silo: "BF", owner_user_id: null }] };
    }
    return { rows: [] };
  };
  return { pool: { query, connect: async () => ({ query, release: () => undefined }) }, runQuery: query };
});
vi.mock("../modules/applications/applications.repo.js", () => ({ findActiveDocumentVersion: async () => null }));
vi.mock("../lib/storage/index.js", () => ({
  getStorage: () => ({ get: async (key: string) => (state.files[key] ? { buffer: state.files[key], contentType: "application/pdf" } : null) }),
}));
vi.mock("../services/smsService.js", () => ({ sendSMS: vi.fn() }));
vi.mock("../services/email/graphSendService.js", () => ({ sendViaGraph: vi.fn() }));

const ID = "11111111-1111-4111-8111-111111111111";
async function app() {
  const { default: router } = await import("../routes/serviceBridge.js");
  const a = express();
  a.use("/api/service", router);
  return a;
}

beforeEach(() => {
  process.env.BACKEND_SERVICE_TOKEN = "test-token-v701";
  state.linked = true;
  state.files = { "docs/june.pdf": Buffer.from("%PDF-june") };
});

describe("v701 BI can fetch the file behind a copied document", () => {
  it("returns the file for a document on a BI-linked application", async () => {
    const res = await request(await app()).get(`/api/service/bi-documents/${ID}/file`).set("x-backend-token", "test-token-v701");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(Buffer.from(res.body).toString()).toBe("%PDF-june");
  });
  it("refuses without the service token", async () => {
    const res = await request(await app()).get(`/api/service/bi-documents/${ID}/file`);
    expect(res.status).toBe(401);
  });
  it("does not serve documents of applications that are not linked to BI", async () => {
    state.linked = false;
    const res = await request(await app()).get(`/api/service/bi-documents/${ID}/file`).set("x-backend-token", "test-token-v701");
    expect(res.status).toBe(404);
  });
  it("rejects a malformed id", async () => {
    const res = await request(await app()).get("/api/service/bi-documents/not-an-id/file").set("x-backend-token", "test-token-v701");
    expect(res.status).toBe(400);
  });
});

describe("v701 every document reaches the linked PGI application", () => {
  beforeEach(() => {
    process.env.BI_SERVER_URL = "https://bi.test";
    state.queries = [];
    state.backfillRows = [];
  });

  it("catch-up resends anything not yet copied, whatever its age, and stamps what arrived", async () => {
    state.backfillRows = [{ id: "doc-old", application_id: ID, category: "A/R", filename: "ar.pdf", size_bytes: 10, blob_url: "https://blob/ar.pdf" }];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, bi_document_id: "bi-doc-1", bi_application_id: "bi-app-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { backfillPgiMirrors } = await import("../services/biDocMirror.js");
      expect(await backfillPgiMirrors()).toEqual({ eligible: 1, mirrored: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
    const select = state.queries.find((q) => q.sql.includes("WHERE a.bi_public_id IS NOT NULL") && q.sql.includes("FROM documents d"));
    expect(select).toBeTruthy();
    expect(select!.sql).toContain("AND d.bi_mirrored_at IS NULL");
    // No age window: an old document that never reached BI is still eligible.
    expect(select!.sql).not.toMatch(/created_at\s*>=/);
    expect(select!.params).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stamp = state.queries.filter((q) => q.sql.includes("UPDATE documents SET bi_mirrored_at = now()"));
    expect(stamp.map((q) => q.params)).toEqual([["doc-old"]]);
  });

  it("copies existing documents as soon as the application is linked at submit", async () => {
    vi.resetModules();
    const mirrorDocs = vi.fn(async () => ({ eligible: 0, mirrored: 0 }));
    vi.doMock("../services/biDocMirror.js", () => ({ mirrorApplicationDocsToBi: mirrorDocs }));
    vi.doMock("../services/biHandoff.js", () => ({
      postBiHandoff: vi.fn(async () => ({ ok: true, biApplicationId: "bi-app", biPublicId: "BI-1", completionUrl: "https://bi.test/c/1" })),
    }));
    vi.doMock("../services/applicationCrmMirror.js", () => ({ mirrorApplicationToCrm: vi.fn(async () => undefined) }));
    vi.doMock("../services/termSheetSigned.js", () => ({ termSheetSigned: vi.fn(async () => false) }));
    const { buildV1App } = await import("./helpers/v1AppsHarness.js");
    const res = await request(await buildV1App())
      .post(`/api/client/applications/${ID}/submit`)
      .send({ app: { pgi_opt_in: "yes", business: { companyName: "Acme" } } });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mirrorDocs).toHaveBeenCalledWith(ID));
    const link = state.queries.find((q) => q.sql.includes("SET bi_application_id = $1"));
    expect(link?.params).toEqual(["bi-app", "BI-1", "https://bi.test/c/1", ID]);
  });

  it("adds the bi_mirrored_at column idempotently", () => {
    expect(readFileSync("migrations/2026_10_01_v701_bi_mirrored_at.sql", "utf8")).toContain("ADD COLUMN IF NOT EXISTS bi_mirrored_at");
  });
});
