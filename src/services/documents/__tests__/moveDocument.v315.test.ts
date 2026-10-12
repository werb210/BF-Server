// BF_SERVER_MOVE_DOCUMENT_v315
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db.js");
  const pool = { query: h.queryMock, connect: async () => ({ query: h.queryMock, release: () => undefined }) };
  return { ...actual, pool, dbQuery: h.queryMock, runQuery: h.queryMock, db: pool };
});
vi.mock("../../biDocMirror.js", async (orig) => ({
  ...(await orig<typeof import("../../biDocMirror.js")>()),
  mirrorDocToBiAsync: () => undefined,
  withdrawDocFromBiAsync: () => undefined,
}));
vi.mock("../../../modules/ocr/ocr.service.js", () => ({ enqueueOcrForDocument: async () => undefined }));
vi.mock("../../../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: async () => undefined }));
import { canMoveDocuments, cleanCategory, moveDocument } from "../moveDocument.js";
import documentsRouter from "../../../routes/documents.js";

describe("moving a document to another category", () => {
  it("only staff can move documents", () => {
    expect(canMoveDocuments("Admin")).toBe(true);
    expect(canMoveDocuments("Staff")).toBe(true);
    expect(canMoveDocuments("client")).toBe(false);
    expect(canMoveDocuments("lender")).toBe(false);
    expect(canMoveDocuments("")).toBe(false);
  });

  it("requires a category", () => {
    expect(cleanCategory("  6 months business banking statements ")).toBe("6 months business banking statements");
    expect(cleanCategory("")).toBeNull();
    expect(cleanCategory(42)).toBeNull();
  });

  it("moves category and document type together and clears the auto-moved marker", async () => {
    const query = vi.fn(async (sql: string) => sql.startsWith("SELECT") ? { rows: [{ id: "d1", application_id: "a1", category: "A/R" }] } : { rows: [] });
    const r = await moveDocument(query as any, "d1", "6 months business banking statements", "u1");
    expect(r).toMatchObject({ ok: true, from: "A/R", to: "6 months business banking statements", changed: true });
    const update = String(query.mock.calls[1][0]);
    expect(update).toContain("document_type = $2");
    expect(update).toContain("category_before_retag = NULL");
  });

  it("reports a missing document and ignores a move to the same category", async () => {
    expect(await moveDocument((async () => ({ rows: [] })) as any, "x", "A/R", null)).toEqual({ ok: false, reason: "not_found" });
    const same = vi.fn(async () => ({ rows: [{ id: "d1", application_id: "a1", category: "A/R" }] }));
    expect((await moveDocument(same as any, "d1", "A/R", null)).changed).toBe(false);
    expect(same).toHaveBeenCalledTimes(1);
  });

  it("is routed, behind requireAuth and the staff check", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/documents", documentsRouter);
    const sign = (role: string) => "Bearer " + jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role, tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    h.queryMock.mockImplementation(answerBySql([
      [/category FROM documents WHERE id::text/, { rows: [{ id: "d1", application_id: "a1", category: "A/R" }] }],
    ]));
    const url = "/api/documents/d1/category";
    expect((await request(app).post(url).send({ category: "A/P" })).status).toBe(401);
    expect(callsMatching(h.queryMock, /UPDATE documents/)).toHaveLength(0);
    expect((await request(app).post(url).set("Authorization", sign("Staff")).send({})).status).toBe(400);
    const r = await request(app).post(url).set("Authorization", sign("Staff")).send({ category: "A/P" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ok: true, from: "A/R", to: "A/P", changed: true });
    expect(callsMatching(h.queryMock, /UPDATE documents/)[0][1]).toEqual(["d1", "A/P"]);
    h.queryMock.mockImplementation(answerBySql([]));
    const missing = await request(app).post(url).set("Authorization", sign("Admin")).send({ category: "A/P" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("DOCUMENT_NOT_FOUND");
  });
});
