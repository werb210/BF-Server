// BF_SERVER_BLOCK_v468_STAFF_ANSWERS + BF_SERVER_BLOCK_v468_STAGE_AFTER_SEND
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return {
    ...actual,
    pool: { query: queryMock, connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })) },
    runQuery: queryMock, dbQuery: queryMock, query: queryMock,
  };
});
vi.mock("../services/submission/orchestrator.js", () => ({ progressSubmission: vi.fn(async () => ({})), readReadinessSnapshot: vi.fn(async () => ({})) }));
vi.mock("../services/lenderMatchCache.js", async (orig) => ({
  ...(await orig<typeof import("../services/lenderMatchCache.js")>()),
  getOutstandingRequiredDocs: vi.fn(async () => ["something"]),
  computeAndCacheLenderMatches: vi.fn(async () => undefined),
}));

const migration = fs.readFileSync("migrations/2026_09_24_v468_sent_apps_off_to_lender.sql", "utf8");

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DOC_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STAFF_ID = "00000000-0000-4000-8000-0000000000b1";
const token = () => jwt.sign({ sub: STAFF_ID, role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function buildApp() {
  const apps = (await import("../modules/applications/applications.routes.js")).default;
  const portal = (await import("../routes/portal.js")).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/applications", apps);
  app.use("/api/portal", portal);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { queryMock.mockReset(); });

describe("v468 staff can answer a blank product question", () => {
  const locApp = { product_category: "LINE_OF_CREDIT", metadata: { applicant: { firstName: "Tanya" }, business: {} } };
  beforeEach(() => {
    queryMock.mockImplementation(answerBySql([
      [/select id, silo from applications/, { rows: [{ id: APP_ID, silo: "BF" }] }],
      [/SELECT product_category, metadata FROM applications/, { rows: [locApp] }],
      [/jsonb_array_elements/, { rows: [{ matched: true }] }],
    ]));
  });
  const patch = async (answers: Record<string, unknown>) =>
    request(await buildApp()).patch(`/api/applications/${APP_ID}/product-questions`).set("Authorization", `Bearer ${token()}`).send({ answers });

  it("no longer refuses a staff answer to an unanswered question", async () => {
    const res = await patch({ "business.riskGovtArrears": "No" });
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual(["business.riskGovtArrears"]);
    const [, params] = callsMatching(queryMock, /UPDATE applications SET metadata = \$2::jsonb/)[0]!;
    const saved = JSON.parse(String((params as unknown[])[1]));
    expect(saved.business.riskGovtArrears).toBe("No");
    expect(saved.product_questions.loc_accord.staff_edits[0]).toMatchObject({ by: STAFF_ID, fields: ["business.riskGovtArrears"] });
  });

  it("still refuses an empty answer", async () => {
    const res = await patch({ "business.riskGovtArrears": "  ", "business.fiscalYearEnd": "December" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "empty_answer", message: "Choose an answer before saving.", ids: ["business.riskGovtArrears"] });
    expect(callsMatching(queryMock, /UPDATE applications SET metadata/)).toHaveLength(0);
  });
});

describe("v468 a sent application goes back to Off to Lender, not In Review", () => {
  const accept = async (sentPackages: number) => {
    queryMock.mockImplementation(answerBySql([
      [/UPDATE documents SET status = 'accepted'/, { rows: [{ id: DOC_ID, document_type: "Void cheque", application_id: APP_ID, status: "accepted" }] }],
      [/SELECT silo FROM applications/, { rows: [{ silo: "BF" }] }],
      [/SELECT pipeline_state, previous_processing_stage/, { rows: [{ pipeline_state: "Additional Steps Required", previous_processing_stage: null }] }],
      [/count\(\*\) FILTER \(WHERE status = 'accepted'\)/, { rows: [{ total: "2", accepted: "2" }] }],
      [/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: "Additional Steps Required" }] }],
      [/FROM application_packages WHERE application_id::text = \(\$1\)::text AND sent_at IS NOT NULL/, { rows: [{ n: sentPackages }] }],
    ]));
    const res = await request(await buildApp()).post(`/api/portal/documents/${DOC_ID}/accept`).set("Authorization", `Bearer ${token()}`).send({});
    expect(res.status).toBe(200);
    const [, stageParams] = callsMatching(queryMock, /UPDATE applications SET pipeline_state = \$2/)[0]!;
    const [, eventParams] = callsMatching(queryMock, /INSERT INTO application_stage_events/)[0]!;
    return { stageParams, eventParams };
  };

  it("documents-accepted checks for a package already sent", async () => {
    const { stageParams, eventParams } = await accept(1);
    expect(stageParams).toEqual([APP_ID, "Off to Lender"]);
    expect(eventParams).toEqual([APP_ID, "Additional Steps Required", "Off to Lender", STAFF_ID, "All documents accepted"]);
  });

  it("a file never sent goes to In Review", async () => {
    const { stageParams, eventParams } = await accept(0);
    expect(stageParams).toEqual([APP_ID, "In Review"]);
    expect(eventParams).toEqual([APP_ID, "Additional Steps Required", "In Review", STAFF_ID, "All documents accepted"]);
  });

  it("the backfill only moves Received / In Review files that were sent", () => {
    expect(migration).toContain("WHERE a.pipeline_state IN ('Received', 'In Review')");
    expect(migration).toContain("AND p.sent_at IS NOT NULL");
    expect(migration).not.toContain("Additional Steps Required',");
  });
});
