// BF_SERVER_MIME_DOT_SUFFIX_v1 - the officedocument allowlist prefix must
// match dot-continued mimes (docx = ...officedocument.wordprocessingml.document).
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  const pool = { query: h.queryMock, connect: async () => ({ query: h.queryMock, release: () => undefined }) };
  return { ...actual, pool, dbQuery: h.queryMock, runQuery: h.queryMock, db: pool };
});
vi.mock("../lib/storage/index.js", () => ({
  getStorage: () => ({ put: async () => ({ hash: "h", blobName: "b", url: "u", sizeBytes: 4 }) }),
}));
vi.mock("../modules/ocr/ocr.service.js", () => ({ enqueueOcrForDocument: async () => undefined }));
vi.mock("../services/biDocMirror.js", () => ({ mirrorDocToBiAsync: () => undefined, withdrawDocFromBiAsync: () => undefined }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: async () => undefined }));
vi.mock("../routes/clientDocumentsNeeded.js", () => ({ computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }) }));

import documentsRouter from "../routes/documents.js";

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const app = express();
app.use(express.json());
app.use("/api/documents", documentsRouter);
let ip = 1;
const upload = (mime: string) => request(app).post("/api/documents/public-upload")
  .set("X-Forwarded-For", `10.7.0.${ip++}`).set("X-Continuation-Token", "cont-mime")
  .field("applicationId", APP_ID).field("category", "bank_statements")
  .attach("file", Buffer.from("PK\u0003\u0004 office " + mime), { filename: "f.bin", contentType: mime });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([
    [/FROM application_continuations/, { rows: [{ ok: 1 }] }],
    [/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: "Documents Required" }] }],
  ]));
});
afterEach(() => vi.restoreAllMocks());

describe("public upload mime allowlist", () => {
  it("accepts dot-suffixed office mimes", async () => {
    for (const mime of [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument",
    ]) {
      const r = await upload(mime);
      expect(r.status, mime).toBe(200);
    }
    expect(callsMatching(h.queryMock, /INSERT INTO documents/)).toHaveLength(4);
  });

  it("does not let the dot rule widen the allowlist", async () => {
    for (const mime of ["application/vnd.openxmlformats-officedocumentx", "application/x-msdownload", "application/javascript"]) {
      const r = await upload(mime);
      expect(r.status, mime).toBe(415);
      expect(r.body.error).toBe("UNSUPPORTED_FILE_TYPE");
    }
    expect(callsMatching(h.queryMock, /INSERT INTO documents/)).toHaveLength(0);
  });
});
