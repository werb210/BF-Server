// BF_SERVER_v817_MAYA - client Maya reads the same to-do list, counts and stage label as the client portal.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock } };
});
// The to-do list itself is buildActionCenter's (covered by its own tests); here it is the portal's real
// shape for "TEST - Todd's Grocery Store": every document done, three forms left.
const CENTER = {
  outstanding: [
    { key: "form:advisors", kind: "form", label: "Professional Advisors", urgent: false },
    { key: "form:debt", kind: "form", label: "Debt Stack", urgent: false },
    { key: "form:networth", kind: "form", label: "Personal Net Worth", urgent: false },
  ],
  completed: Array.from({ length: 11 }, (_, i) => ({ key: "upload:d" + i, kind: "document", label: "Doc " + i, urgent: false })),
  outstandingCount: 3,
};
vi.mock("../services/applicantActions.js", () => ({ buildActionCenter: vi.fn(async () => CENTER) }));

import router, { assembleClientChecklist, clientStageLabel } from "../routes/mayaClientChecklist.js";

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaa1234bbbb";
const PHONE = "+1 (780) 555-0101";

function db(opts: { mine: number; total?: number; stage?: string; signed?: string | null; finalized?: number }) {
  return answerBySql([
    [/WITH app_phones/, { rows: [{ total: opts.total ?? 1, mine: opts.mine, known: 1 }] }],
    [/FROM applications a WHERE a\.id/, { rows: [{ pipeline_state: opts.stage ?? "Additional Steps Required", submitted_at: "2026-10-01T00:00:00Z", signnow_app_signed_at: opts.signed ?? null, finalized_lenders: opts.finalized ?? 0 }] }],
    [/INSERT INTO maya_audit/, { rows: [] }],
  ]);
}

describe("client Maya checklist (v817)", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/maya", router);
  const svc = () => "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
  const post = (body: Record<string, unknown>, auth = svc()) => request(app).post("/api/maya/client-checklist").set("Authorization", auth).send(body);

  beforeEach(() => queryMock.mockReset());

  it("returns the portal's forms, counts and short stage label for the owner's application", async () => {
    queryMock.mockImplementation(db({ mine: 1 }));
    const r = await post({ application_id: APP_ID, phone: PHONE });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.stage).toBe("Additional Steps");
    expect(r.body.progress).toBe("11 of 14 done");
    expect(r.body.outstanding_count).toBe(3);
    expect(r.body.outstanding_forms).toBe(3);
    expect(r.body.outstanding_documents).toBe(0);
    expect(r.body.outstanding.map((i: any) => i.label)).toEqual(["Professional Advisors", "Debt Stack", "Personal Net Worth"]);
    expect(r.body.what_happens_next).toBe("Lenders need a few more items before your file moves on: 3 forms.");
    // ownership is checked against the phone's last 10 digits
    expect(callsMatching(queryMock, /WITH app_phones/)[0][1]).toEqual([APP_ID, "7805550101"]);
  });

  it("refuses an application that belongs to someone else, and never builds its list", async () => {
    queryMock.mockImplementation(db({ mine: 0 }));
    const r = await post({ application_id: APP_ID, phone: PHONE });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("forbidden");
    expect(callsMatching(queryMock, /FROM applications a WHERE a\.id/)).toHaveLength(0);
  });

  it("needs a verified phone and a service token", async () => {
    queryMock.mockImplementation(db({ mine: 1 }));
    expect((await post({ application_id: APP_ID })).status).toBe(403);
    expect((await post({ application_id: APP_ID, phone: PHONE }, "Bearer nope")).status).toBe(401);
    expect((await post({ application_id: "not-a-uuid", phone: PHONE })).status).toBe(400);
  });

  it("adds the signing to-do while signing is open, like the portal", () => {
    const out = assembleClientChecklist({ pipeline_state: "Offer", submitted_at: "x", signed_at: null, finalized_lenders: 1 }, { outstanding: [], completed: [], outstandingCount: 0 });
    expect(out.outstanding).toEqual([{ label: "Sign your application documents", type: "action", status: "outstanding" }]);
    const signed = assembleClientChecklist({ pipeline_state: "Offer", submitted_at: "x", signed_at: "2026-10-02", finalized_lenders: 1 }, { outstanding: [], completed: [], outstandingCount: 0 });
    expect(signed.outstanding_count).toBe(0);
    expect(signed.what_happens_next).toBe("You have an offer. Review it, then accept it or ask for changes.");
  });

  it("never says nothing is needed at Additional Steps without saying the advisor is checking", () => {
    const out = assembleClientChecklist({ pipeline_state: "Additional Steps Required", submitted_at: "x", signed_at: null, finalized_lenders: 0 }, { outstanding: [], completed: [], outstandingCount: 0 });
    expect(out.what_happens_next).toMatch(/advisor is checking/);
  });

  it("labels stages exactly like the portal header", () => {
    expect(clientStageLabel("Additional Steps Required")).toBe("Additional Steps");
    expect(clientStageLabel("Accepted")).toBe("Funded");
    expect(clientStageLabel("Off to Lender")).toBe("Off to Lender");
    expect(clientStageLabel("Draft", true)).toBe("Not finished");
  });
});
