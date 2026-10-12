// BF_SERVER_SHARED_DOCS_COMPANION_ALL_v1 - an upload is mirrored into a closing-cost companion leg
// UNCONDITIONALLY (a companion is the same borrower and deal), rather than gating on the companion's own
// required-doc set, which is empty on a freshly-spawned companion. Other linked legs keep the gate.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn(), outstanding: vi.fn(), ocr: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  const pool = { query: h.queryMock, connect: async () => ({ query: h.queryMock, release: () => undefined }) };
  return { ...actual, pool, dbQuery: h.queryMock, runQuery: h.queryMock, db: pool };
});
vi.mock("../lib/storage/index.js", () => ({
  getStorage: () => ({ put: async () => ({ hash: "hash-1", blobName: "blob-1", url: "https://blob/1", sizeBytes: 10 }) }),
}));
vi.mock("../modules/ocr/ocr.service.js", () => ({ enqueueOcrForDocument: h.ocr }));
vi.mock("../services/biDocMirror.js", () => ({ mirrorDocToBiAsync: () => undefined, withdrawDocFromBiAsync: () => undefined }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: async () => undefined }));
vi.mock("../routes/clientDocumentsNeeded.js", () => ({ computeOutstandingDocs: h.outstanding }));

import documentsRouter from "../routes/documents.js";

const PARENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_LEG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FAMILY_SQL = /WITH root AS/;
const app = express();
app.use(express.json());
app.use("/api/documents", documentsRouter);
let ip = 1;
const upload = (category = "bank_statements") => request(app).post("/api/documents/public-upload")
  .set("X-Forwarded-For", `10.8.0.${ip++}`).set("X-Continuation-Token", "cont")
  .field("applicationId", PARENT).field("category", category)
  .attach("file", Buffer.from("%PDF-1.4 statement"), { filename: "s.pdf", contentType: "application/pdf" });

const siblingInserts = () => callsMatching(h.queryMock, /INSERT INTO documents/)
  .map((c) => (c[1] as unknown[])[1])
  .filter((appId) => appId !== PARENT);

beforeEach(() => {
  h.ocr.mockReset();
  h.ocr.mockResolvedValue(undefined);
  h.outstanding.mockReset();
  // Neither linked leg lists bank statements among its own required documents.
  h.outstanding.mockResolvedValue({ required: [{ document_type: "void_cheque" }], stillNeeded: [], rejected: [] });
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([
    [/FROM application_continuations/, { rows: [{ ok: 1 }] }],
    [/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: "Documents Required" }] }],
    [FAMILY_SQL, { rows: [{ id: COMPANION, is_companion: true }, { id: OTHER_LEG, is_companion: false }] }],
  ]));
});

describe("companion document sharing", () => {
  it("selects the companion flag from application metadata", async () => {
    expect((await upload()).status).toBe(200);
    const [fam] = callsMatching(h.queryMock, FAMILY_SQL);
    expect(sqlText(fam[0])).toContain("closing_cost_companion");
    expect(sqlText(fam[0])).toContain("is_companion");
    expect(fam[1]).toEqual([PARENT]);
  });

  it("mirrors into companions before consulting the required-set gate", async () => {
    expect((await upload()).status).toBe(200);
    // The companion gets the file although its required set does not include it, without consulting the gate.
    expect(siblingInserts()).toEqual([COMPANION]);
    expect(h.outstanding.mock.calls.map((c) => c[0])).toEqual([OTHER_LEG]);
    const [ins] = callsMatching(h.queryMock, /INSERT INTO documents/).filter((c) => (c[1] as unknown[])[1] === COMPANION);
    expect(ins[1]).toEqual(expect.arrayContaining(["bank_statements", "blob-1", "https://blob/1", "hash-1"]));
    expect(callsMatching(h.queryMock, /INSERT INTO document_versions/).some((c) => String((c[1] as unknown[])[4]).includes(PARENT))).toBe(true);
  });

  it("a non-companion leg still receives the file when its required set asks for it", async () => {
    h.outstanding.mockResolvedValue({ required: [{ document_type: "Bank_Statements " }], stillNeeded: [], rejected: [] });
    expect((await upload()).status).toBe(200);
    expect(siblingInserts().sort()).toEqual([COMPANION, OTHER_LEG].sort());
  });

  it("does not copy a file the companion already has", async () => {
    h.queryMock.mockImplementation(answerBySql([
      [/FROM application_continuations/, { rows: [{ ok: 1 }] }],
      [/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: "Documents Required" }] }],
      [FAMILY_SQL, { rows: [{ id: COMPANION, is_companion: true }] }],
      [/SELECT 1 FROM documents WHERE application_id::text = \(\$1\)::text AND hash = \$2/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === COMPANION ? [{ "?column?": 1 }] : [] })],
    ]));
    expect((await upload()).status).toBe(200);
    expect(siblingInserts()).toEqual([]);
  });

  it("never shares an 'Other' document", async () => {
    h.queryMock.mockImplementation(answerBySql([
      [/FROM application_continuations/, { rows: [{ ok: 1 }] }],
      [/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: "Documents Required" }] }],
      [FAMILY_SQL, { rows: [{ id: COMPANION, is_companion: true }] }],
    ]));
    const r = await upload("Other");
    expect(r.status).toBe(200);
    expect(callsMatching(h.queryMock, FAMILY_SQL)).toHaveLength(0);
    expect(siblingInserts()).toEqual([]);
  });
});
