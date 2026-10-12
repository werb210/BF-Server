// BF_SERVER_BLOCK_v493_MAYA_DATES_OWNER_BRIEFING
// Maya's application summary says when a file was started and submitted and who owns it, and no Maya answer
// reads the (empty) application_required_documents table.
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
    required: [{ document_type: "bank_statements", label: "Bank statements" }],
    stillNeeded: [{ document_type: "bank_statements" }],
    rejected: [],
  }),
}));

import mayaStaff from "../routes/mayaStaff.js";

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const app = express();
app.use(express.json());
app.use("/api/maya", mayaStaff);
const svc = () => "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const post = (p: string, body: Record<string, unknown>) => request(app).post("/api/maya" + p).set("Authorization", svc()).send(body);

let appRow: Record<string, unknown>;
const APP_SQL = /FROM applications WHERE id::text = \$1 LIMIT 1/;

beforeEach(() => {
  appRow = {
    id: APP_ID, name: "Todd's Grocery", pipeline_state: "In Review", status: "IN_REVIEW", requested_amount: "50000",
    created_at: "2026-09-01T10:00:00.000Z", submitted_at: "2026-09-03T12:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
    owner_user_id: OWNER_ID, currency: "CAD",
  };
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/application_required_documents/, new Error('relation "application_required_documents" is empty and retired')],
    [APP_SQL, () => ({ rows: [appRow] })],
    [/FROM users WHERE id::text = \$1/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === OWNER_ID ? [{ name: "Sam Staff", email: "sam@boreal.test" }] : [] })],
    [/FROM applications a\s+LEFT JOIN application_contacts/, { rows: [{ app_name: "Todd's Grocery", applicant_name: "Todd W" }], rowCount: 1 }],
    [/FROM applications a\s+JOIN contacts c ON c.id = a.contact_id/, { rows: [{ id: APP_ID, name: "Todd's Grocery", contact_name: "Todd W" }] }],
  ]));
});

describe("v493 Maya dates, owner, briefing", () => {
  it("summary carries start date, submitted date and owner", async () => {
    const r = await post("/staff/application-summary", { application_id: APP_ID });
    expect(r.status).toBe(200);
    expect(r.body.summary.startedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(r.body.summary.submittedAt).toBe("2026-09-03T12:00:00.000Z");
    expect(r.body.summary.owner).toEqual({ name: "Sam Staff", email: "sam@boreal.test" });
    const sql = sqlText(callsMatching(queryMock, APP_SQL)[0][0]);
    expect(sql).toContain("created_at, submitted_at, owner_user_id::text AS owner_user_id");
    expect(callsMatching(queryMock, /FROM users WHERE id::text = \$1/)[0][1]).toEqual([OWNER_ID]);
  });

  it("an application with no owner says unassigned and skips the user lookup", async () => {
    appRow = { ...appRow, owner_user_id: null, created_at: null, submitted_at: null };
    const r = await post("/staff/application-summary", { application_id: APP_ID });
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ owner: "unassigned", startedAt: null, submittedAt: null });
    expect(callsMatching(queryMock, /FROM users WHERE id::text = \$1/)).toHaveLength(0);
  });

  it("a failed owner lookup does not fail the summary", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM users WHERE id::text = \$1/, new Error("users unavailable")],
      [APP_SQL, () => ({ rows: [appRow] })],
    ]));
    const r = await post("/staff/application-summary", { application_id: APP_ID });
    expect(r.status).toBe(200);
    expect(r.body.summary.owner).toBe("unassigned");
  });

  it("no read of the empty application_required_documents table remains", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["/staff/application-summary", { application_id: APP_ID }],
      ["/staff/underwriting-summary", { application_id: APP_ID }],
      ["/staff/risk-flags", { application_id: APP_ID }],
      ["/staff/docs-request-draft", { application_id: APP_ID }],
      ["/staff/applications-by-phone", { phone: "7805550123" }],
      ["/staff/daily-briefing", { silo: "BF" }],
    ];
    for (const [p, body] of calls) {
      const r = await post(p, body);
      expect(r.status, p).toBe(200);
    }
    expect(callsMatching(queryMock, /(FROM|JOIN) application_required_documents/)).toHaveLength(0);
  });
});
