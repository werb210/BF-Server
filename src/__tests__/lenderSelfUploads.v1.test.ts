// BF_SERVER_LENDER_SELF_UPLOADS_v1 - lender uploads are stored in lender_documents,
// scoped to the lender in the token, and ingested into Maya's knowledge.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), embedAndStore: vi.fn(), fetch: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
vi.mock("../ai/embeddingService.js", () => ({ extractTextFromBuffer: async (buf: Buffer) => buf.toString("utf8") }));
vi.mock("../modules/ai/knowledge.service.js", () => ({ embedAndStore: (...a: unknown[]) => h.embedAndStore(...a) }));
import lenderSelf from "../routes/lenderSelf.js";

const A = "41414141-4141-4141-8141-414141414141";
const B = "42424242-4242-4242-8242-424242424242";
const token = (id: string) => "Bearer " + jwt.sign({ sub: "lender:" + id, role: "Lender", lenderId: id }, process.env.JWT_SECRET as string);
const app = express();
app.use("/api/lender", lenderSelf);

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/INSERT INTO lender_documents/, (_sql: string, params?: unknown[]) => ({ rows: [{ id: "doc-" + String(params?.[0]).slice(0, 2), filename: params?.[1], mime_type: params?.[2], created_at: "2026-10-01" }] })],
    [/FROM lender_documents\s+WHERE lender_id::text = \$1/, (_sql: string, params?: unknown[]) => ({ rows: params?.[0] === A ? [{ id: "doc-41", filename: "a.txt" }] : [] })],
  ]));
  h.embedAndStore.mockReset();
  h.fetch.mockReset();
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("lender self uploads", () => {
  it("stores in lender_documents scoped to the lender and ingests to Maya", async () => {
    const up = await request(app).post("/api/lender/uploads").set("Authorization", token(A))
      .attach("file", Buffer.from("Factoring up to 90% of invoices."), { filename: "rates.txt", contentType: "text/plain" });
    expect(up.status).toBe(201);
    const [sql, params] = callsMatching(h.query, /INSERT INTO lender_documents/)[0] as [string, unknown[]];
    expect(sql).toContain("(id, lender_id, filename, mime_type, blob_url, uploaded_by, created_at)");
    expect(params[0]).toBe(A);
    expect(h.embedAndStore).toHaveBeenCalledWith(expect.anything(), "Factoring up to 90% of invoices.", "lender_document", "doc-41", "rates.txt");
    // BF_SERVER_LENDER_TESTS_v58 - no POST to the agent's non-existent /api/knowledge/ingest.
    expect(h.fetch).not.toHaveBeenCalled();

    // Lender B only ever sees its own uploads.
    const listA = await request(app).get("/api/lender/uploads").set("Authorization", token(A));
    const listB = await request(app).get("/api/lender/uploads").set("Authorization", token(B));
    expect(listA.body.data).toHaveLength(1);
    expect(listB.body.data).toEqual([]);
    expect(callsMatching(h.query, /FROM lender_documents/).map((c) => (c[1] as unknown[])[0])).toEqual([A, B]);
  });

  it("a non-lender cannot upload", async () => {
    const staff = "Bearer " + jwt.sign({ sub: A, role: "Staff", lenderId: A }, process.env.JWT_SECRET as string);
    const r = await request(app).post("/api/lender/uploads").set("Authorization", staff)
      .attach("file", Buffer.from("x"), { filename: "x.txt", contentType: "text/plain" });
    expect(r.status).toBe(403);
    expect(callsMatching(h.query, /INSERT INTO lender_documents/)).toHaveLength(0);
  });
});
