// BF_SERVER_BLOCK_v482_MARK_SENT_TO_LENDER
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock, dbQuery: queryMock };
});

const migration = readFileSync(fileURLToPath(new URL("../../migrations/2026_09_24_v482_manual_lender_send.sql", import.meta.url)), "utf-8");

const STAFF_ID = "00000000-0000-4000-8000-0000000000b1";
const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LENDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const staffToken = () => jwt.sign({ sub: STAFF_ID, role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
const readOnlyToken = () => jwt.sign({ sub: STAFF_ID, role: "Staff", tokenVersion: 0, tv: 0, capabilities: ["application:read"] }, process.env.JWT_SECRET as string);

async function buildApp() {
  const router = (await import("../modules/applications/applications.routes.js")).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/applications", router);
  app.use(errorHandler);
  return app;
}

function answers(stage: string, moved: boolean) {
  return answerBySql([
    [/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: stage }] }],
    [/SELECT name FROM lenders/, { rows: [{ name: "Acme Capital" }] }],
    [/UPDATE applications SET pipeline_state = 'Off to Lender'/, moved ? { rows: [{ id: APP_ID }], rowCount: 1 } : { rows: [], rowCount: 0 }],
  ]);
}

const markSent = async (token: string, body: Record<string, unknown> = { note: "Emailed to Jane" }) =>
  request(await buildApp()).post(`/api/applications/${APP_ID}/lenders/${LENDER_ID}/mark-sent`).set("Authorization", `Bearer ${token}`).send(body);

beforeEach(() => { queryMock.mockReset(); });

describe("v482 mark as sent to lender", () => {
  it("migration is idempotent", () => {
    const adds = migration.match(/ADD COLUMN/g) ?? [];
    const safe = migration.match(/ADD COLUMN IF NOT EXISTS/g) ?? [];
    expect(adds.length).toBe(3);
    expect(safe.length).toBe(3);
  });

  it("route is write-gated", async () => {
    queryMock.mockImplementation(answers("In Review", true));
    const res = await markSent(readOnlyToken());
    expect(res.status).toBe(403);
    expect(callsMatching(queryMock, /INSERT INTO application_packages/)).toHaveLength(0);
  });

  it("records a sent package flagged as manual", async () => {
    queryMock.mockImplementation(answers("In Review", true));
    const res = await markSent(staffToken());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ lenderId: LENDER_ID, lenderName: "Acme Capital", sentManually: true });
    const [sql, params] = callsMatching(queryMock, /INSERT INTO application_packages/)[0]!;
    expect(sqlText(sql)).toContain("VALUES ($1, $2::uuid, 'sent', NOW(), TRUE, $3, $4, NOW())");
    expect(sqlText(sql)).toContain("ON CONFLICT (application_id, lender_id) DO UPDATE");
    expect(params).toEqual([APP_ID, LENDER_ID, STAFF_ID, "Emailed to Jane"]);
  });

  it("moves to Off to Lender and records the stage change", async () => {
    queryMock.mockImplementation(answers("In Review", true));
    const res = await markSent(staffToken());
    expect(res.body.data.stage).toBe("Off to Lender");
    const [, params] = callsMatching(queryMock, /INSERT INTO application_stage_history/)[0]!;
    expect(params).toEqual([APP_ID, "In Review", "Marked as sent to Acme Capital outside the portal", STAFF_ID]);
  });

  it("never moves backwards from later stages", async () => {
    queryMock.mockImplementation(answers("Offer", false));
    const res = await markSent(staffToken());
    expect(res.status).toBe(200);
    expect(res.body.data.stage).toBe("Offer");
    const [sql] = callsMatching(queryMock, /UPDATE applications SET pipeline_state = 'Off to Lender'/)[0]!;
    expect(sqlText(sql)).toMatch(/NOT IN \('Off to Lender','Additional Steps Required','Offer','Accepted','Rejected','Declined','Funded','Closed'\)/);
    expect(callsMatching(queryMock, /INSERT INTO application_stage_history/)).toHaveLength(0);
  });

  it("sent-lenders tells the portal which sends were recorded by hand", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT silo FROM applications/, { rows: [{ silo: "BF" }] }],
      [/FROM application_packages p/, { rows: [
        { lender_id: LENDER_ID, sent_at: "2026-10-01T00:00:00Z", sent_manually: true },
        { lender_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", sent_at: "2026-10-01T00:00:00Z", sent_manually: false },
      ] }],
    ]));
    const res = await request(await buildApp()).get(`/api/applications/${APP_ID}/sent-lenders`).set("Authorization", `Bearer ${staffToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.sent.map((s: any) => s.manual)).toEqual([true, false]);
    const [sql] = callsMatching(queryMock, /FROM application_packages p/)[0]!;
    expect(sqlText(sql)).toContain("BOOL_OR(COALESCE(p.sent_manually, FALSE)) AS sent_manually");
  });
});
