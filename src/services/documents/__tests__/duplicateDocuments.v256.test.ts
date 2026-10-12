// BF_SERVER_DOCUMENT_DUPLICATE_GUARD_v256
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn(), put: vi.fn() }));
vi.mock("../../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db.js");
  const pool = { query: h.queryMock, connect: async () => ({ query: h.queryMock, release: () => undefined }) };
  return { ...actual, pool, dbQuery: h.queryMock, runQuery: h.queryMock, db: pool };
});
vi.mock("../../../lib/storage/index.js", () => ({ getStorage: () => ({ put: h.put }) }));
vi.mock("../../../modules/ocr/ocr.service.js", () => ({ enqueueOcrForDocument: async () => undefined }));
vi.mock("../../biDocMirror.js", () => ({ mirrorDocToBiAsync: () => undefined, withdrawDocFromBiAsync: () => undefined }));
vi.mock("../../../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: async () => undefined }));
vi.mock("../../../routes/clientDocumentsNeeded.js", () => ({ computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }) }));
import { assertNotDuplicate, duplicateGroupsForApplication, DuplicateDocumentError, fingerprint } from "../duplicateDocuments.js";
import documentsRouter, { persistAndEnqueue } from "../../../routes/documents.js";
import accountantRouter from "../../../routes/accountant.js";

const APP = "467689d3-2008-42a6-87d3-720919c6e5b9";
const balanceSheet = Buffer.from("%PDF-1.4 Voss Events Balance Sheet 4.30.26");

describe("upload guard", () => {
  it("lets a new file through and returns its fingerprint", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    expect(await assertNotDuplicate(APP, balanceSheet, query)).toBe(fingerprint(balanceSheet));
    expect((query.mock.calls[0] as any)[1]).toEqual([APP, fingerprint(balanceSheet)]);
  });
  it("refuses the same file on the same application, naming where it already is", async () => {
    const existing = { id: "d1", category: "Balance Sheet - Interim financials", filename: "Voss Events Balance Sheet - 4.30.26 (1).pdf", status: "uploaded" };
    const query = vi.fn(async () => ({ rows: [existing] }));
    const err = await assertNotDuplicate(APP, balanceSheet, query).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateDocumentError);
    expect(err.name).toBe("DuplicateDocumentError");
    expect(err.existing).toEqual(existing);
    expect(err.message).toBe("This file is already uploaded on this application under Balance Sheet - Interim financials.");
  });
  it("identical bytes always share a fingerprint and different bytes never do", () => {
    expect(fingerprint(Buffer.from("a"))).toBe(fingerprint(Buffer.from("a")));
    expect(fingerprint(Buffer.from("a"))).not.toBe(fingerprint(Buffer.from("b")));
  });
});

describe("existing duplicates", () => {
  it("groups copies behind the oldest upload", async () => {
    const docs = [
      { id: "d1", category: "Balance Sheet - Interim financials", filename: "BS.pdf", status: "uploaded", created_at: "2026-09-11T10:00:00Z" },
      { id: "d2", category: "A/P", filename: "BS.pdf", status: "uploaded", created_at: "2026-09-11T10:01:00Z" },
      { id: "d3", category: "other", filename: "BS.pdf", status: "uploaded", created_at: "2026-09-11T10:02:00Z" },
    ];
    const query = vi.fn(async () => ({ rows: [{ hash: "h1", docs }] }));
    const groups = await duplicateGroupsForApplication(APP, query);
    expect(groups).toEqual([{ hash: "h1", original: docs[0], copies: [docs[1], docs[2]] }]);
    expect(String((query.mock.calls[0] as any)[0])).toContain("HAVING COUNT(*) > 1");
  });
});

describe("wiring", () => {
  const EXISTING = { id: "d1", category: "Balance Sheet - Interim financials", filename: "BS.pdf", status: "uploaded" };
  const DUP_SQL = /FROM documents\s+WHERE application_id::text = \(\$1\)::text AND hash = \$2/;
  const ACCOUNTANT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const sign = (claims: Record<string, unknown>) => "Bearer " + jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: "HS256" });
  const app = express();
  app.use(express.json());
  app.use("/api/documents", documentsRouter);
  app.use("/api/accountant", accountantRouter);
  let ip = 1;

  const holdsDuplicate = (dup: boolean) => {
    h.put.mockReset();
    h.put.mockResolvedValue({ hash: fingerprint(balanceSheet), blobName: "b", url: "u", sizeBytes: balanceSheet.length });
    h.queryMock.mockReset();
    h.queryMock.mockImplementation(answerBySql([
      [DUP_SQL, (_s: string, p?: unknown[]) => ({ rows: dup && p?.[0] === APP && p?.[1] === fingerprint(balanceSheet) ? [EXISTING] : [] })],
      [/FROM application_continuations/, { rows: [{ ok: 1 }] }],
      [/JOIN accountant_invites ai/, { rows: [{ pipeline_state: "Documents Required" }] }],
      [/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: "Documents Required" }] }],
      [/WITH root AS/, { rows: [] }],
    ]));
  };
  const file = { buffer: balanceSheet, originalname: "BS.pdf", mimetype: "application/pdf" } as Express.Multer.File;

  it("checks before anything is written to storage", async () => {
    holdsDuplicate(true);
    const err = await persistAndEnqueue({ applicationId: APP, category: "A/P", file }).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateDocumentError);
    expect(h.put).not.toHaveBeenCalled();
    expect(callsMatching(h.queryMock, /INSERT INTO documents/)).toHaveLength(0);
    expect(callsMatching(h.queryMock, DUP_SQL)[0][1]).toEqual([APP, fingerprint(balanceSheet)]);

    holdsDuplicate(false);
    await expect(persistAndEnqueue({ applicationId: APP, category: "A/P", file })).resolves.toMatchObject({ hash: fingerprint(balanceSheet) });
    expect(h.put).toHaveBeenCalledTimes(1);
  });

  it("answers 409 with the existing document on every upload route", async () => {
    holdsDuplicate(true);
    const routes = [
      request(app).post("/api/documents/public-upload").set("X-Forwarded-For", `10.5.0.${ip++}`).set("X-Continuation-Token", "c")
        .field("applicationId", APP).field("category", "bank_statements"),
      request(app).post("/api/documents/upload").set("Authorization", sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Staff", tokenVersion: 0, tv: 0 }))
        .field("applicationId", APP).field("category", "bank_statements"),
    ];
    for (const r of routes) {
      const res = await r.attach("file", balanceSheet, { filename: "BS.pdf", contentType: "application/pdf" });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ ok: false, error: "DUPLICATE_DOCUMENT", existing: EXISTING });
      expect(res.body.message).toBe("This file is already uploaded on this application under Balance Sheet - Interim financials.");
    }
    const acc = await request(app).post(`/api/accountant/applications/${APP}/upload`)
      .set("Authorization", sign({ role: "accountant", contactId: ACCOUNTANT }))
      .field("category", "A/P")
      .attach("files", balanceSheet, { filename: "BS.pdf", contentType: "application/pdf" });
    expect(acc.status).toBe(409);
    expect(acc.body).toMatchObject({ error: "DUPLICATE_DOCUMENT", existing: EXISTING });
    expect(h.put).not.toHaveBeenCalled();
  });

  it("lists existing duplicates for staff on /:applicationId/duplicates", async () => {
    const docs = [
      { id: "d1", category: "A/P", filename: "BS.pdf", status: "uploaded", created_at: "2026-09-11T10:00:00Z" },
      { id: "d2", category: "A/R", filename: "BS.pdf", status: "uploaded", created_at: "2026-09-11T10:01:00Z" },
    ];
    h.queryMock.mockReset();
    h.queryMock.mockImplementation(answerBySql([[/HAVING COUNT\(\*\) > 1/, { rows: [{ hash: "h1", docs }] }]]));
    expect((await request(app).get(`/api/documents/${APP}/duplicates`)).status).toBe(401);
    const res = await request(app).get(`/api/documents/${APP}/duplicates`).set("Authorization", sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Staff", tokenVersion: 0, tv: 0 }));
    expect(res.status).toBe(200);
    expect(res.body.data.groups).toEqual([{ hash: "h1", original: docs[0], copies: [docs[1]] }]);
  });
});
