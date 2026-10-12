// BF_SERVER_PNW_ATTACH_v1 - the signed Personal Net Worth PDF must be attached
// to the application's Documents list, not only surfaced inside the lender
// package. Attachment fires from the SignNow webhook on PNW completion and, as
// a backfill, when staff open the application.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";
import { postSignnowWebhook, signnowWebhookApp } from "./helpers/signnowWebhook.js";

const { dbQuery, clientQuery, groupStatus, downloadMock, putMock } = vi.hoisted(() => ({
  dbQuery: vi.fn(), clientQuery: vi.fn(), groupStatus: vi.fn(), downloadMock: vi.fn(), putMock: vi.fn(),
}));
vi.mock("../db.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  dbQuery,
  runQuery: dbQuery,
  pool: { query: dbQuery, connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })) },
}));
vi.mock("../signnow/signnowClient.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isApiKeyConfigured: () => true,
  getDocumentGroupStatus: groupStatus,
  downloadDocument: downloadMock,
}));
vi.mock("../lib/storage/index.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getStorage: () => ({ put: putMock }) }));

import { attachSignedPnwDocument, PNW_DOCUMENT_CATEGORY } from "../signnow/pnwSigning.js";

const APP = "aaaaaaaa-1111-4222-8333-444444444444";
let existing = false;
function pnwDb(extra: Array<[RegExp, unknown]> = []) {
  dbQuery.mockImplementation(answerBySql([
    ...extra,
    [/FROM documents\s+WHERE application_id/, () => ({ rows: existing ? [{ id: "doc-existing" }] : [] })],
    [/metadata->'pnw_signnow'->>'group_id' AS group_id/, { rows: [{ group_id: "pnw-group", doc_id: "pnw-doc" }] }],
  ]));
}

beforeEach(() => {
  existing = false;
  dbQuery.mockReset();
  clientQuery.mockReset();
  clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  groupStatus.mockReset();
  groupStatus.mockResolvedValue({ signed: true, summary: "signed" });
  downloadMock.mockReset();
  downloadMock.mockResolvedValue(Buffer.from("%PDF-1.7 signed pnw"));
  putMock.mockReset();
  putMock.mockResolvedValue({ blobName: "applications/x/pnw.pdf", url: "https://blob/pnw.pdf", sizeBytes: 19 });
  pnwDb();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("PNW document attachment helper", () => {
  it("exports attachSignedPnwDocument and a Documents-list category", () => {
    expect(typeof attachSignedPnwDocument).toBe("function");
    expect(PNW_DOCUMENT_CATEGORY).toBe("Personal Net Worth");
  });

  it("downloads the signed PDF and inserts a documents + document_versions row", async () => {
    expect(await attachSignedPnwDocument(APP)).toMatchObject({ attached: true });
    expect(downloadMock).toHaveBeenCalledWith("pnw-doc");
    expect(putMock).toHaveBeenCalledWith(expect.objectContaining({ contentType: "application/pdf", pathPrefix: `applications/${APP}` }));
    const sql = clientQuery.mock.calls.map((c) => sqlText(c[0]));
    expect(sql).toEqual(["BEGIN", expect.stringContaining("INSERT INTO documents"), expect.stringContaining("INSERT INTO document_versions"), "COMMIT"]);
    const docParams = clientQuery.mock.calls[1]![1] as unknown[];
    expect(docParams[1]).toBe(APP);
    expect(docParams[4]).toBe(PNW_DOCUMENT_CATEGORY);
    expect(docParams[9]).toBe("personal_net_worth");
    expect(sql[1]).toContain("'system'");
  });

  it("is idempotent by system document identity before downloading", async () => {
    existing = true;
    expect(await attachSignedPnwDocument(APP)).toEqual({ attached: true, reason: "already_attached" });
    const [identity] = callsMatching(dbQuery, /FROM documents/);
    expect(sqlText(identity![0])).toContain("AND document_type = 'personal_net_worth'");
    expect(sqlText(identity![0])).toContain("AND uploaded_by = 'system'");
    expect(sqlText(identity![0])).not.toContain("hash");
    expect(groupStatus).not.toHaveBeenCalled();
    expect(downloadMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("only attaches a confirmed-signed PNW", async () => {
    groupStatus.mockResolvedValue({ signed: false, summary: "pending" });
    expect(await attachSignedPnwDocument(APP)).toEqual({ attached: false, reason: "not_signed" });
    expect(downloadMock).not.toHaveBeenCalled();
    expect(clientQuery).not.toHaveBeenCalled();
  });
});

describe("PNW attachment triggers", () => {
  it("the SignNow webhook attaches on PNW completion (matched by group/doc id)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    pnwDb([[/where metadata->'pnw_signnow'->>'group_id' = any/, { rows: [{ id: APP }] }]]);
    const router = (await import("../routes/signnow.js")).default;
    const res = await postSignnowWebhook(signnowWebhookApp(router), { event: "document.complete", document_group_id: "pnw-group" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, match: "pnw", attached: true });
    const [match] = callsMatching(dbQuery, /metadata->'pnw_signnow'->>'group_id' = any/);
    expect(match![1]).toEqual([["pnw-group"]]);
    expect(downloadMock).toHaveBeenCalledWith("pnw-doc");
    expect(clientQuery.mock.calls.some((c) => sqlText(c[0]).includes("INSERT INTO documents"))).toBe(true);
  });

  it("staff opening the application backfills an already-signed PNW", async () => {
    const { markReady } = await import("../startupState.js");
    markReady();
    pnwDb([
      [/SELECT pipeline_state, silo FROM applications/, { rows: [{ pipeline_state: "In Review", silo: "BF" }] }],
      [/from applications\s+where id = \$1/i, { rows: [{ id: APP, name: "Voss Events", pipeline_state: "In Review", metadata: {} }] }],
    ]);
    const router = (await import("../routes/portal.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/portal", router);
    const STAFF = "00000000-0000-4000-8000-0000000000a1";
    const tok = jwt.sign({ sub: STAFF, id: STAFF, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
    const res = await request(app).get(`/api/portal/applications/${APP}`).set("Authorization", `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.application.id).toBe(APP);
    expect(callsMatching(dbQuery, /FROM documents\s+WHERE application_id[\s\S]*personal_net_worth/)[0]![1]).toEqual([APP]);
    expect(downloadMock).toHaveBeenCalledWith("pnw-doc");
    expect(clientQuery.mock.calls.some((c) => sqlText(c[0]).includes("INSERT INTO documents"))).toBe(true);
  });
});
