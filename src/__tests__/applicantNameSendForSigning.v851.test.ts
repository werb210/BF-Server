// BF_SERVER_v851_APPLICANT_NAME - staff "Send for signing" refuses with applicant_name_missing instead of sending to
// "Unknown (application started)"; with the corrected CRM name it sends.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getOrCreateEmbeddedSigningSession: vi.fn(async () => ({ status: "ready" })),
}));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return {
    ...actual,
    pool: { query: h.queryMock, connect: vi.fn(async () => ({ query: h.queryMock, release: vi.fn() })) },
    runQuery: h.queryMock, dbQuery: h.queryMock, query: h.queryMock,
  };
});
vi.mock("../services/submission/orchestrator.js", () => ({
  readReadinessSnapshot: vi.fn(async () => ({ allDocsAccepted: true, allTasksComplete: true, lenderSelectionsFinalized: true, applicationSigned: false, collateralRequired: false, collateralComplete: false })),
}));
vi.mock("../signnow/sba/sbaTrigger.js", () => ({
  isSbaApplication: vi.fn(async () => false),
  sbaEnvelopeCount: vi.fn(async () => 0),
  sbaFormsComplete: vi.fn(async () => ({ complete: true, missing: [] })),
  startSbaSigningForStaff: vi.fn(),
}));
vi.mock("../signnow/embeddedSigningSession.js", () => ({ getOrCreateEmbeddedSigningSession: h.getOrCreateEmbeddedSigningSession }));

const APP_ID = "dddddddd-dddd-4ddd-8ddd-dddddddd0851";
const token = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
const PLACEHOLDER_APPLICANT = { firstName: "Unknown", lastName: "(application started)" };

async function buildApp() {
  const router = (await import("../modules/applications/applications.routes.js")).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/applications", router);
  app.use(errorHandler);
  return app;
}
function answer(resolveRow: Record<string, unknown>) {
  h.queryMock.mockImplementation(answerBySql([
    [/SELECT silo FROM applications/, { rows: [{ silo: "BF" }] }],
    [/AS v851_applicant/, { rows: [resolveRow] }],
  ]));
}
const send = async () => request(await buildApp()).post(`/api/applications/${APP_ID}/resend-signing`).set("Authorization", `Bearer ${token()}`).send({});

beforeEach(() => {
  h.queryMock.mockReset();
  h.getOrCreateEmbeddedSigningSession.mockClear();
});

describe("v851 Send for signing needs the applicant's name", () => {
  it("refuses with 422 applicant_name_missing when neither the application nor the contact has a real name", async () => {
    answer({ v851_applicant: PLACEHOLDER_APPLICANT, v851_contact_first: "Unknown", v851_contact_last: "(application started)", v851_contact_name: "Unknown (application started)" });
    const r = await send();
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: "applicant_name_missing", message: "Add the applicant's name first" });
    expect(h.getOrCreateEmbeddedSigningSession).not.toHaveBeenCalled();
  });

  it("uses (and saves) the corrected CRM contact name, then sends", async () => {
    answer({ v851_applicant: PLACEHOLDER_APPLICANT, v851_contact_first: "Jordan", v851_contact_last: "Rivers", v851_contact_name: "Jordan Rivers" });
    const r = await send();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ok: true });
    expect(h.getOrCreateEmbeddedSigningSession).toHaveBeenCalledWith(APP_ID);
    const write = callsMatching(h.queryMock, /UPDATE applications[\s\S]*'\{applicant\}'/);
    expect(write).toHaveLength(1);
    expect(write[0][1]).toEqual([APP_ID, "Jordan", "Rivers", "Jordan Rivers"]);
  });
});
