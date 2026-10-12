// BF_SERVER_MOVE_MIRROR_v393
// "Move to..." on a document copies it to BI when the move changed the category, BI decides which
// categories it needs, and a failed lookup never fails the move.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn(), mirror: vi.fn(), withdraw: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  const pool = { query: h.queryMock, connect: async () => ({ query: h.queryMock, release: () => undefined }) };
  return { ...actual, pool, dbQuery: h.queryMock, runQuery: h.queryMock, db: pool };
});
vi.mock("../services/biDocMirror.js", async (orig) => ({
  ...(await orig<typeof import("../services/biDocMirror.js")>()),
  mirrorDocToBiAsync: h.mirror,
  withdrawDocFromBiAsync: h.withdraw,
}));
vi.mock("../modules/ocr/ocr.service.js", () => ({ enqueueOcrForDocument: async () => undefined }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: async () => undefined }));

import documentsRouter from "../routes/documents.js";
import { shouldMirrorToPgi } from "../services/biDocMirror.js";

const DOC_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const app = express();
app.use(express.json());
app.use("/api/documents", documentsRouter);
const staff = () => "Bearer " + jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const move = (category: string) => request(app).post(`/api/documents/${DOC_ID}/category`).set("Authorization", staff()).send({ category });

const BEFORE_SQL = /SELECT id::text AS id, application_id::text AS application_id, category FROM documents/;
const LOOKUP_SQL = /SELECT filename, size_bytes, blob_url FROM documents/;

beforeEach(() => {
  h.mirror.mockReset();
  h.withdraw.mockReset();
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([
    [BEFORE_SQL, { rows: [{ id: DOC_ID, application_id: APP_ID, category: "6 months business banking statements" }] }],
    [LOOKUP_SQL, { rows: [{ filename: "ar-aging.pdf", size_bytes: 2048, blob_url: "https://blob/ar" }] }],
  ]));
});
afterEach(() => vi.restoreAllMocks());

describe("Move to... copies the document to BI", () => {
  it("mirrors after a move that changed the category", async () => {
    const r = await move("A/R");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ok: true, changed: true, from: "6 months business banking statements", to: "A/R" });
    expect(h.mirror).toHaveBeenCalledTimes(1);
    expect(h.mirror).toHaveBeenCalledWith({
      bfApplicationId: APP_ID,
      bfDocumentId: DOC_ID,
      documentType: "A/R",
      fileName: "ar-aging.pdf",
      mimeType: null,
      fileSize: 2048,
      storageUrl: "https://blob/ar",
      uploadedByName: null,
    });
  });

  it("does not mirror a move to the category the document already had", async () => {
    const r = await move("6 months business banking statements");
    expect(r.status).toBe(200);
    expect(r.body.data.changed).toBe(false);
    expect(h.mirror).not.toHaveBeenCalled();
  });

  it("the mirror still decides which categories BI needs", () => {
    expect(shouldMirrorToPgi("A/R")).toBe(true);
    expect(shouldMirrorToPgi("PnL \u2013 Interim financials")).toBe(true);
    expect(shouldMirrorToPgi("6 months business banking statements")).toBe(false);
  });

  it("a failed lookup never fails the move", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.queryMock.mockImplementation(answerBySql([
      [BEFORE_SQL, { rows: [{ id: DOC_ID, application_id: APP_ID, category: "Other" }] }],
      [LOOKUP_SQL, new Error("documents unavailable")],
    ]));
    const r = await move("A/R");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ok: true, changed: true, to: "A/R" });
    expect(h.mirror).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[documents] move mirror lookup failed", expect.objectContaining({ documentId: DOC_ID }));
  });
});
