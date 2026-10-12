// BF_SERVER_ACCOUNTANT_UPLOAD_v1
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn(), put: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  const pool = { query: h.queryMock, connect: async () => ({ query: h.queryMock, release: () => undefined }) };
  return { ...actual, pool, dbQuery: h.queryMock, runQuery: h.queryMock, db: pool };
});
vi.mock("../lib/storage/index.js", () => ({ getStorage: () => ({ put: h.put }) }));
vi.mock("../modules/ocr/ocr.service.js", () => ({ enqueueOcrForDocument: async () => undefined }));
vi.mock("../services/biDocMirror.js", async (orig) => ({ ...(await orig<typeof import("../services/biDocMirror.js")>()), mirrorDocToBiAsync: () => undefined, withdrawDocFromBiAsync: () => undefined }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: async () => undefined }));
vi.mock("../routes/clientDocumentsNeeded.js", () => ({ computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }) }));

import accountantRouter, { ACCOUNTANT_ALLOWED_MIME_PREFIXES, isAllowedAccountantMime } from "../routes/accountant.js";
import documentsRouter, { persistAndEnqueue } from "../routes/documents.js";

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNTANT_CONTACT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APPLICANT_CONTACT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CONT_TOKEN = "cont-token-accountant";
const OWNED_SQL = /JOIN accountant_invites ai/;

const app = express();
app.use(express.json());
app.use("/api/accountant", accountantRouter);
app.use("/api/documents", documentsRouter);

const accountantToken = (contactId = ACCOUNTANT_CONTACT) =>
  "Bearer " + jwt.sign({ role: "accountant", contactId, phone: "+15875550111" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
let stage: string | null;
let ip = 1;

function accountantUpload(category: string, opts: { contactId?: string; mime?: string } = {}) {
  return request(app)
    .post(`/api/accountant/applications/${APP_ID}/upload`)
    .set("Authorization", accountantToken(opts.contactId))
    .field("category", category)
    .attach("files", Buffer.from("%PDF-1.4 accountant"), { filename: "pnl.pdf", contentType: opts.mime ?? "application/pdf" });
}
function publicUpload(mime: string) {
  return request(app)
    .post("/api/documents/public-upload")
    .set("X-Forwarded-For", `10.9.0.${ip++}`)
    .set("X-Continuation-Token", CONT_TOKEN)
    .field("applicationId", APP_ID)
    .field("category", "bank_statements")
    .attach("file", Buffer.from("%PDF-1.4 " + mime), { filename: "f.bin", contentType: mime });
}

beforeEach(() => {
  stage = "Documents Required";
  h.put.mockReset();
  h.put.mockResolvedValue({ hash: "h1", blobName: "blob-1", url: "https://blob/1", sizeBytes: 19 });
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([
    // The invitation binds the accountant contact to the application; the applicant is someone else.
    [OWNED_SQL, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === APP_ID && p?.[1] === ACCOUNTANT_CONTACT ? [{ pipeline_state: stage }] : [] })],
    [/FROM applications\s+WHERE id::text = \(\$1\)::text AND contact_id/, (_s: string, p?: unknown[]) => ({ rows: p?.[1] === APPLICANT_CONTACT ? [{ pipeline_state: stage }] : [] })],
    [/FROM application_continuations/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === CONT_TOKEN ? [{ ok: 1 }] : [] })],
    [/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: "Documents Required" }] }],
  ]));
});

describe("BF_SERVER_ACCOUNTANT_UPLOAD_v1", () => {
  it("accepts the file types the applicant upload accepts", () => {
    expect(isAllowedAccountantMime("application/pdf")).toBe(true);
    expect(isAllowedAccountantMime("image/jpeg")).toBe(true);
    expect(isAllowedAccountantMime("text/csv")).toBe(true);
  });

  it("accepts Office mimes, whose prefix continues with a dot", () => {
    expect(isAllowedAccountantMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
    expect(isAllowedAccountantMime("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true);
  });

  it("rejects executables and empty mimes", () => {
    expect(isAllowedAccountantMime("application/x-msdownload")).toBe(false);
    expect(isAllowedAccountantMime("")).toBe(false);
    expect(isAllowedAccountantMime(null)).toBe(false);
  });

  it("has not drifted from the applicant upload allowlist", async () => {
    for (const prefix of ACCOUNTANT_ALLOWED_MIME_PREFIXES) {
      const r = await publicUpload(prefix);
      expect(r.status, prefix).toBe(200);
    }
    const word = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect((await publicUpload(word)).status).toBe(200);
    expect(isAllowedAccountantMime(word)).toBe(true);
    expect((await publicUpload("application/x-msdownload")).status).toBe(415);
    expect(isAllowedAccountantMime("application/x-msdownload")).toBe(false);
  });

  it("enforces the allow-list on write, not only on read", async () => {
    const r = await accountantUpload("Personal net worth statement");
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("CATEGORY_NOT_PERMITTED");
    expect(h.put).not.toHaveBeenCalled();
    expect(callsMatching(h.queryMock, /INSERT INTO documents/)).toHaveLength(0);
    // Always-available categories are accepted even though they are not in the per-file list.
    expect((await accountantUpload("Lease agreement")).status).toBe(200);
  });

  // BF_SERVER_ACCOUNTANT_UPLOAD_SCOPE_TEST_v2
  it("scopes ownership to the token's contact via the invitation", async () => {
    expect((await accountantUpload("A/R")).status).toBe(200);
    const [owned] = callsMatching(h.queryMock, OWNED_SQL);
    expect(sqlText(owned[0])).toContain("JOIN accountant_invites ai ON ai.application_id::text = a.id::text");
    expect(sqlText(owned[0])).toContain("ai.contact_id::text = ($2)::text");
    expect(owned[1]).toEqual([APP_ID, ACCOUNTANT_CONTACT]);
    const stranger = await accountantUpload("A/R", { contactId: "99999999-9999-4999-8999-999999999999" });
    expect(stranger.status).toBe(404);
    expect(stranger.body.error).toBe("APPLICATION_NOT_FOUND");
  });

  it("never scopes on applications.contact_id, which is the applicant", async () => {
    // The applicant's own contact id holds no invitation, so it gets nothing.
    expect((await accountantUpload("A/R", { contactId: APPLICANT_CONTACT })).status).toBe(404);
    for (const c of callsMatching(h.queryMock, /FROM applications a/)) {
      expect(sqlText(c[0])).not.toContain("AND contact_id::text = ($2)::text");
    }
  });

  it("refuses uploads onto a closed file", async () => {
    for (const closed of ["Funded", "Closed", "Rejected", "Accepted"]) {
      stage = closed;
      const r = await accountantUpload("A/R");
      expect(r.status, closed).toBe(409);
      expect(r.body.error).toBe("APPLICATION_NOT_ACCEPTING_UPLOADS");
    }
    expect(h.put).not.toHaveBeenCalled();
  });

  it("shares the applicant persistence path rather than forking it", async () => {
    expect(typeof persistAndEnqueue).toBe("function");
    const r = await accountantUpload("A/R");
    expect(r.status).toBe(200);
    expect(h.put).toHaveBeenCalledTimes(1);
    expect(h.put.mock.calls[0][0]).toMatchObject({ pathPrefix: `applications/${APP_ID}`, filename: "pnl.pdf" });
    expect(callsMatching(h.queryMock, /INSERT INTO documents/)).toHaveLength(1);
    expect(callsMatching(h.queryMock, /INSERT INTO document_versions/)).toHaveLength(1);
    // The duplicate guard on that path answers the accountant too.
    h.queryMock.mockImplementation(answerBySql([
      [OWNED_SQL, { rows: [{ pipeline_state: "Documents Required" }] }],
      [/FROM documents\s+WHERE application_id::text = \(\$1\)::text AND hash = \$2/, { rows: [{ id: "d1", category: "A/R", filename: "pnl.pdf", status: "uploaded" }] }],
    ]));
    const dup = await accountantUpload("A/R");
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ ok: false, error: "DUPLICATE_DOCUMENT", existing: { id: "d1" } });
  });

  it("records who sent it", async () => {
    await accountantUpload("A/R");
    const [ins] = callsMatching(h.queryMock, /INSERT INTO documents/);
    expect((ins[1] as unknown[])[9]).toBe(`accountant:${ACCOUNTANT_CONTACT}`);
  });
});
