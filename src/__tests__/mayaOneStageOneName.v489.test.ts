// BF_SERVER_BLOCK_v489_MAYA_ONE_STAGE_ONE_NAME
// application-summary returns the top-level fields the client tools read, a missing application is audited,
// and find_mine gives one business name: the application's.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock } };
});
vi.mock("../routes/clientDocumentsNeeded.js", () => ({
  computeOutstandingDocs: async () => ({
    required: [{ document_type: "bank_statements", label: "Bank statements" }, { document_type: "void_cheque", label: "Void cheque" }],
    stillNeeded: [{ document_type: "void_cheque" }],
    rejected: [],
  }),
}));

import mayaStaff from "../routes/mayaStaff.js";

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const app = express();
app.use(express.json());
app.use("/api/maya", mayaStaff);
const svc = () => "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const post = (p: string, body: Record<string, unknown>) => request(app).post("/api/maya" + p).set("Authorization", svc()).send(body);

const APP_SQL = /FROM applications WHERE id::text = \$1 LIMIT 1/;
const FIND_SQL = /FROM applications a\s+JOIN contacts c ON c.id = a.contact_id/;
const APP_ROW = {
  id: APP_ID, name: "Todd's Grocery", pipeline_state: "Documents Required", status: "IN_REVIEW", requested_amount: "75000",
  created_at: "2026-09-01", updated_at: "2026-10-01", currency: "CAD",
  bi_public_id: "BI-123", bi_completion_url: "https://bi.example.test/complete/BI-123",
};

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [APP_SQL, { rows: [APP_ROW] }],
    [/SELECT category, status FROM documents/, { rows: [{ category: "bank_statements", status: "accepted" }] }],
  ]));
});

describe("v489 Maya one stage, one name", () => {
  it("application-summary returns the top-level fields the client tools read", async () => {
    const r = await post("/staff/application-summary", { application_id: APP_ID });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      pipeline_state: "Documents Required",
      requested_amount: "75000",
      bi_public_id: "BI-123",
      bi_completion_url: "https://bi.example.test/complete/BI-123",
    });
    expect(r.body.pipeline_state).toBe(r.body.summary.stage);
    expect(r.body.documents).toEqual([
      { document_category: "Bank statements", status: "accepted" },
      { document_category: "Void cheque", status: "missing" },
    ]);
    expect(sqlText(callsMatching(queryMock, APP_SQL)[0][0])).toContain("bi_public_id, bi_completion_url");
  });

  it("falls back to status for the one stage, and nulls a missing BI link", async () => {
    queryMock.mockImplementation(answerBySql([[APP_SQL, { rows: [{ ...APP_ROW, pipeline_state: null, bi_public_id: undefined, bi_completion_url: undefined }] }]]));
    const r = await post("/staff/application-summary", { application_id: APP_ID });
    expect(r.body.pipeline_state).toBe("IN_REVIEW");
    expect(r.body.summary.stage).toBe("IN_REVIEW");
    expect(r.body.bi_completion_url).toBeNull();
    expect(r.body.bi_public_id).toBeNull();
  });

  it("a missing application is audited", async () => {
    queryMock.mockImplementation(answerBySql([[APP_SQL, { rows: [] }]]));
    const r = await post("/staff/application-summary", { application_id: APP_ID });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not_found");
    const audits = callsMatching(queryMock, /INSERT INTO maya_audit/);
    expect(audits).toHaveLength(1);
    const p = audits[0][1] as unknown[];
    expect(p[4]).toBe("application.summary");
    expect(p[6]).toBe("application not found");
    expect(p[7]).toBe(false);
    expect(p[8]).toBe("not_found");
  });

  it("find_mine gives one business name, the application's", async () => {
    queryMock.mockImplementation(answerBySql([
      [FIND_SQL, { rows: [{ id: APP_ID, name: "Todd's Grocery", company_name: "Some Old CRM Company", contact_name: "Todd W" }] }],
    ]));
    const r = await post("/staff/applications-by-phone", { phone: "7805550123" });
    expect(r.status).toBe(200);
    expect(r.body.applications[0].businessName).toBe("Todd's Grocery");
    expect(r.body.contact.companyName).toBe("Todd's Grocery");
    expect(r.body.summary).toContain('Refer to the business as "Todd\'s Grocery"');
  });

  it("find_mine falls back to the CRM company only when there is no application", async () => {
    queryMock.mockImplementation(answerBySql([
      [FIND_SQL, { rows: [] }],
      [/FROM contacts\s+WHERE right/, { rows: [{ contact_name: "Todd W", company_name: "Some Old CRM Company" }] }],
    ]));
    const r = await post("/staff/applications-by-phone", { phone: "7805550123" });
    expect(r.body.contact.companyName).toBe("Some Old CRM Company");
  });
});
