// BF_SERVER_LENDER_SELF_V2 - behaviour guards:
// 1) phantom lender_products.description (dropped by migration 041) must never
//    reappear in the product SQL (it 500ed every lender-portal product call),
// 2) term/rate-period fields present, 3) the /uploads pair exists and feeds
//    lender_documents + Maya ingest.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), embedAndStore: vi.fn(), extract: vi.fn(), fetch: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
vi.mock("../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: async () => ({ smsSent: 0, notifsCreated: 0, recipientCount: 0 }) }));
vi.mock("../ai/embeddingService.js", () => ({ extractTextFromBuffer: (...a: unknown[]) => h.extract(...a) }));
vi.mock("../modules/ai/knowledge.service.js", () => ({ embedAndStore: (...a: unknown[]) => h.embedAndStore(...a) }));
import lenderSelf from "../routes/lenderSelf.js";

const LENDER_ID = "31313131-3131-4131-8131-313131313131";
const lender = "Bearer " + jwt.sign({ sub: "lender:" + LENDER_ID, role: "Lender", lenderId: LENDER_ID }, process.env.JWT_SECRET as string);
const app = express();
app.use(express.json());
app.use("/api/lender", lenderSelf);
const product = { name: "Term", category: "TERM", term_min: 6, term_max: 36, rate_period_days: 30 };

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/INSERT INTO lender_products/, { rows: [{ id: "p-new", name: "Term" }] }],
    [/UPDATE lender_products/, { rows: [{ id: "p-1", name: "Term" }] }],
    [/INSERT INTO lender_documents/, { rows: [{ id: "ld-1", filename: "sheet.txt", mime_type: "text/plain", created_at: "2026-10-01" }] }],
  ]));
  h.embedAndStore.mockReset();
  h.extract.mockReset();
  h.extract.mockResolvedValue("Our LOC goes to $500k.");
  h.fetch.mockReset();
  vi.stubGlobal("fetch", h.fetch);
});

afterEach(() => { vi.unstubAllGlobals(); });

async function productCalls() {
  await request(app).get("/api/lender/products").set("Authorization", lender);
  await request(app).post("/api/lender/products").set("Authorization", lender).send(product);
  await request(app).patch("/api/lender/products/p-1").set("Authorization", lender).send(product);
  return callsMatching(h.query, /lender_products/);
}

describe("lenderSelf v2", () => {
  it("does not reference the phantom lender_products.description column", async () => {
    const calls = await productCalls();
    expect(calls).toHaveLength(3);
    for (const [sql] of calls) expect(String(sql)).not.toContain("description");
  });

  it("reads and writes term_min/term_max/rate_period_days", async () => {
    const [read, insert, update] = await productCalls();
    for (const col of ["term_min", "term_max", "rate_period_days"]) {
      expect(String(read[0]), col).toContain(col);
      expect(String(insert[0]), col).toContain(col);
      expect(String(update[0]), col).toContain(col);
    }
    // INSERT: rate_period_days $11, term_min $12, term_max $13; UPDATE: $12, $13, $14.
    expect((insert[1] as unknown[]).slice(10, 13)).toEqual([30, 6, 36]);
    expect(String(update[0])).toContain("rate_period_days = $12");
    expect((update[1] as unknown[]).slice(11, 14)).toEqual([30, 6, 36]);
  });

  it("exposes lender uploads backed by lender_documents + Maya ingest", async () => {
    // BF_SERVER_LENDER_TESTS_v58 - v57 replaced the POST to the agent's
    // /api/knowledge/ingest (which did not exist, and whose failure was
    // swallowed) with a direct embedAndStore call. Same guarantee, real path.
    const list = await request(app).get("/api/lender/uploads").set("Authorization", lender);
    expect(list.status).toBe(200);
    expect(callsMatching(h.query, /FROM lender_documents/)[0][1]).toEqual([LENDER_ID]);

    const up = await request(app).post("/api/lender/uploads").set("Authorization", lender)
      .attach("file", Buffer.from("Our LOC goes to $500k."), { filename: "sheet.txt", contentType: "text/plain" });
    expect(up.status).toBe(201);
    expect(up.body.data).toMatchObject({ id: "ld-1", indexed: true, indexError: null });
    expect((callsMatching(h.query, /INSERT INTO lender_documents/)[0][1] as unknown[]).slice(0, 3)).toEqual([LENDER_ID, "sheet.txt", "text/plain"]);
    expect(h.embedAndStore).toHaveBeenCalledWith(expect.anything(), "Our LOC goes to $500k.", "lender_document", "ld-1", "sheet.txt");
    expect(h.fetch).not.toHaveBeenCalled(); // no cross-service POST to /api/knowledge/ingest

    // The file field is "file" (upload.single("file")).
    const wrongField = await request(app).post("/api/lender/uploads").set("Authorization", lender)
      .attach("document", Buffer.from("x"), { filename: "x.txt", contentType: "text/plain" });
    expect(wrongField.status).not.toBe(201);
  });
});
