// BF_SERVER_MOVE_WITHDRAW_v395
// Moving a document out of a PGI category retires BI's copy.
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

const DOC_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const app = express();
app.use(express.json());
app.use("/api/documents", documentsRouter);
const staff = () => "Bearer " + jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
let current = "A/R";

beforeEach(() => {
  current = "A/R";
  h.withdraw.mockReset();
  h.mirror.mockReset();
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([
    [/application_id::text AS application_id, category FROM documents/, () => ({ rows: [{ id: DOC_ID, application_id: APP_ID, category: current }] })],
    [/SELECT filename, size_bytes, blob_url FROM documents/, { rows: [{ filename: "f.pdf", size_bytes: 1, blob_url: "u" }] }],
  ]));
});
afterEach(() => vi.restoreAllMocks());

describe("moving a document out of a PGI category retires BI's copy", () => {
  it("the move route asks for it", async () => {
    const r = await request(app).post(`/api/documents/${DOC_ID}/category`).set("Authorization", staff()).send({ category: "Lease agreement (if applicable)" });
    expect(r.status).toBe(200);
    expect(h.withdraw).toHaveBeenCalledTimes(1);
    expect(h.withdraw).toHaveBeenCalledWith(APP_ID, DOC_ID, "A/R", "Lease agreement (if applicable)");
  });

  it("a move that changes nothing asks for nothing", async () => {
    const r = await request(app).post(`/api/documents/${DOC_ID}/category`).set("Authorization", staff()).send({ category: "A/R" });
    expect(r.status).toBe(200);
    expect(h.withdraw).not.toHaveBeenCalled();
  });

  it("only fires when the document LEFT a PGI category for a non-PGI one", async () => {
    const { withdrawDocFromBiAsync } = await vi.importActual<typeof import("../services/biDocMirror.js")>("../services/biDocMirror.js");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    withdrawDocFromBiAsync("app", "doc", "Other", "Lease agreement (if applicable)"); // never in BI
    withdrawDocFromBiAsync("app", "doc", "A/R", "A/P");                                // still in BI: re-mirrored instead
    withdrawDocFromBiAsync("app", "doc", "Other", "A/R");                              // moving in, not out
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
