// BF_SERVER_BLOCK_v492_MAYA_REAL_DOCUMENTS
// Every Maya document answer is built from computeOutstandingDocs (the portal's own needed list) plus each
// document's real status in the documents table - never from the empty application_required_documents table.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, outstanding } = vi.hoisted(() => ({ queryMock: vi.fn(), outstanding: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock } };
});
vi.mock("../routes/clientDocumentsNeeded.js", () => ({ computeOutstandingDocs: outstanding }));

import mayaStaff from "../routes/mayaStaff.js";

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP_2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const app = express();
app.use(express.json());
app.use("/api/maya", mayaStaff);
const svc = () => "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const post = (p: string, body: Record<string, unknown>) => request(app).post("/api/maya" + p).set("Authorization", svc()).send(body);
const DOCS_SQL = "SELECT category, status FROM documents WHERE application_id::text = $1";

// Required: bank statements (accepted), tax return (uploaded, not reviewed), void cheque (missing), ID (rejected).
const NEEDED = {
  required: [
    { document_type: "bank_statements", label: "Bank statements" },
    { document_type: "tax_return", label: "Tax return" },
    { document_type: "void_cheque", label: "Void cheque" },
    { document_type: "photo_id", label: "Photo ID" },
  ],
  stillNeeded: [{ document_type: "void_cheque" }, { document_type: "photo_id" }],
  rejected: [{ document_type: "photo_id" }],
};

beforeEach(() => {
  outstanding.mockReset();
  outstanding.mockResolvedValue(NEEDED);
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/application_required_documents/, new Error("retired table")],
    [/FROM applications WHERE id::text = \$1 LIMIT 1/, { rows: [{ id: APP_ID, name: "Todd's Grocery", pipeline_state: "Documents Required", requested_amount: "50000", created_at: "2026-09-01", updated_at: new Date().toISOString(), currency: "CAD" }] }],
    [DOCS_SQL, { rows: [{ category: "bank_statements", status: "Accepted" }, { category: "tax_return", status: "pending" }, { category: "photo_id", status: "rejected" }] }],
    [/FROM applications a\s+LEFT JOIN application_contacts/, { rows: [{ app_name: "Todd's Grocery", applicant_name: "Todd W" }], rowCount: 1 }],
    [/FROM applications a\s+JOIN contacts c ON c.id = a.contact_id/, { rows: [{ id: APP_ID, name: "Todd's Grocery" }, { id: APP_2, name: "Todd's Second Store" }] }],
  ]));
});

describe("v492 Maya reads real documents", () => {
  it("builds rows from computeOutstandingDocs and the documents table", async () => {
    const r = await post("/staff/application-summary", { application_id: APP_ID });
    expect(r.status).toBe(200);
    expect(outstanding).toHaveBeenCalledWith(APP_ID);
    expect(callsMatching(queryMock, DOCS_SQL)[0][1]).toEqual([APP_ID]);
    expect(r.body.documents).toEqual([
      { document_category: "Bank statements", status: "accepted" },
      { document_category: "Tax return (uploaded, awaiting review)", status: "uploaded" },
      { document_category: "Void cheque", status: "missing" },
      { document_category: "Photo ID (rejected - needs re-upload)", status: "rejected" },
    ]);
    expect(r.body.summary.docs).toEqual({
      total: 4, accepted: 1,
      missing: ["Tax return (uploaded, awaiting review)", "Void cheque", "Photo ID (rejected - needs re-upload)"],
    });
  });

  it("no per-application read of the empty application_required_documents table remains", async () => {
    await post("/staff/application-summary", { application_id: APP_ID });
    await post("/staff/underwriting-summary", { application_id: APP_ID });
    await post("/staff/risk-flags", { application_id: APP_ID });
    await post("/staff/docs-request-draft", { application_id: APP_ID });
    await post("/staff/applications-by-phone", { phone: "7805550123" });
    expect(callsMatching(queryMock, /application_required_documents/)).toHaveLength(0);
  });

  it("all five document answers use the helper", async () => {
    const uw = await post("/staff/underwriting-summary", { application_id: APP_ID });
    expect(uw.status).toBe(200);
    expect(uw.body.summary.docs).toMatchObject({ requiredTotal: 4, accepted: 1 });
    expect(uw.body.summary.docs.missing).toContain("Void cheque");

    const rf = await post("/staff/risk-flags", { application_id: APP_ID });
    expect(rf.status).toBe(200);
    expect(rf.body.flags[0]).toBe("3 document(s) outstanding: Tax return (uploaded, awaiting review), Void cheque, Photo ID (rejected - needs re-upload)");

    // Client mode: an upload not yet reviewed counts as received, so it is not requested again.
    const dd = await post("/staff/docs-request-draft", { application_id: APP_ID });
    expect(dd.status).toBe(200);
    expect(dd.body.missing).toEqual(["Void cheque", "Photo ID (rejected - needs re-upload)"]);
    expect(dd.body.draft).toContain("Hi Todd,");

    expect(outstanding.mock.calls.map((c) => c[0])).toEqual([APP_ID, APP_ID, APP_ID]);
  });

  it("find_mine reads the newest application's documents in client mode, and each application's own list", async () => {
    const r = await post("/staff/applications-by-phone", { phone: "7805550123" });
    expect(r.status).toBe(200);
    expect(outstanding.mock.calls.map((c) => c[0])).toEqual([APP_ID, APP_2]);
    expect(r.body.latestDocs.total).toBe(4);
    expect(r.body.latestDocs.missing).toEqual(["Void cheque", "Photo ID (rejected - needs re-upload)"]);
    expect(r.body.latestDocs.documents).toContainEqual({ category: "Tax return (received - our team is reviewing it)", status: "received" });
    expect(r.body.applications[0].documents).toEqual({
      missing: ["Void cheque", "Photo ID (rejected - needs re-upload)"],
      received: ["Tax return (received - our team is reviewing it)"],
      accepted: ["Bank statements"],
    });
    expect(r.body.applications[1].documents.accepted).toEqual(["Bank statements"]);
  });

  it("a failure reading documents degrades to no rows instead of failing the answer", async () => {
    outstanding.mockRejectedValue(new Error("boom"));
    const r = await post("/staff/application-summary", { application_id: APP_ID });
    expect(r.status).toBe(200);
    expect(r.body.documents).toEqual([]);
  });
});
