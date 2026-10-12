// BF_SERVER_BLOCK_v161_TEST_SUITE_REFRESH_v1
// Originally guarded the BF_SERVER_v64_UPLOAD_GUARD sentinel. The functional invariant: a failure inside
// persistAndEnqueue (storage or the documents/document_versions transaction) on either upload route is caught
// and answered with a clean 500 UPLOAD_FAILED, and a failed transaction is rolled back.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn(), put: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  const pool = { query: h.queryMock, connect: async () => ({ query: h.queryMock, release: () => undefined }) };
  return { ...actual, pool, dbQuery: h.queryMock, runQuery: h.queryMock, db: pool };
});
vi.mock("../lib/storage/index.js", () => ({ getStorage: () => ({ put: h.put }) }));
vi.mock("../modules/ocr/ocr.service.js", () => ({ enqueueOcrForDocument: async () => undefined }));
vi.mock("../services/biDocMirror.js", () => ({ mirrorDocToBiAsync: () => undefined, withdrawDocFromBiAsync: () => undefined }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: async () => undefined }));
vi.mock("../routes/clientDocumentsNeeded.js", () => ({ computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }) }));

import documentsRouter from "../routes/documents.js";

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONT_TOKEN = "cont-token-guard";
const app = express();
app.use(express.json());
app.use("/api/documents", documentsRouter);
const staff = () => "Bearer " + jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
let ip = 1;

const ROUTES: Record<string, () => request.Test> = {
  "/public-upload": () => request(app).post("/api/documents/public-upload")
    .set("X-Forwarded-For", `10.6.0.${ip++}`).set("X-Continuation-Token", CONT_TOKEN)
    .field("applicationId", APP_ID).field("category", "bank_statements")
    .attach("file", Buffer.from("%PDF-1.4 guard"), { filename: "s.pdf", contentType: "application/pdf" }),
  "/upload": () => request(app).post("/api/documents/upload").set("Authorization", staff())
    .field("applicationId", APP_ID).field("category", "bank_statements")
    .attach("file", Buffer.from("%PDF-1.4 guard"), { filename: "s.pdf", contentType: "application/pdf" }),
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.put.mockReset();
  h.put.mockResolvedValue({ hash: "h1", blobName: "b1", url: "https://blob/1", sizeBytes: 14 });
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([
    [/FROM application_continuations/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === CONT_TOKEN ? [{ ok: 1 }] : [] })],
    [/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: "Documents Required" }] }],
  ]));
});
afterEach(() => vi.restoreAllMocks());

describe("documents upload guard (functional)", () => {
  for (const [route, send] of Object.entries(ROUTES)) {
    it(`${route} handler catches a storage failure inside persistAndEnqueue`, async () => {
      h.put.mockRejectedValue(new Error("blob storage down"));
      const r = await send();
      expect(r.status).toBe(500);
      expect(r.body).toMatchObject({ status: "error", error: "UPLOAD_FAILED" });
      expect(callsMatching(h.queryMock, /INSERT INTO documents/)).toHaveLength(0);
    });

    it(`${route} handler catches a failed insert and rolls the transaction back`, async () => {
      h.queryMock.mockImplementation(answerBySql([
        [/FROM application_continuations/, { rows: [{ ok: 1 }] }],
        [/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: "Documents Required" }] }],
        [/INSERT INTO documents/, new Error('null value in column "x" violates not-null constraint')],
      ]));
      const r = await send();
      expect(r.status).toBe(500);
      expect(r.body.error).toBe("UPLOAD_FAILED");
      expect(callsMatching(h.queryMock, /^ROLLBACK$/)).toHaveLength(1);
      expect(callsMatching(h.queryMock, /^COMMIT$/)).toHaveLength(0);
    });

    it(`${route} still answers 200 when persistAndEnqueue succeeds`, async () => {
      const r = await send();
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ applicationId: APP_ID, filename: "s.pdf", status: "uploaded" });
    });
  }
});
