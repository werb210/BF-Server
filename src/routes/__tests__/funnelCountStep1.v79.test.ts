// BF_SERVER_FUNNEL_COUNT_STEP1_v79 - a blank draft on step 1 is a phone-verified
// applicant who stopped, so the funnel counts it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});

import marketing from "../marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const FUNNEL = /FROM applications/;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [FUNNEL, { rows: [{ started: 15, step2: 5, step3: 4, step4: 3, step5: 2, step6: 1, submitted: 1 }] }],
  ]));
});

describe("funnel counts verified step-one abandoners v79", () => {
  it("keeps never-progressed application rows in the funnel", async () => {
    const r = await request(app).get("/api/marketing/funnel?days=30").set("Authorization", `Bearer ${token}`).set("X-Silo", "BI");
    expect(r.status).toBe(200);
    const step1 = r.body.data.steps[0];
    expect(step1).toMatchObject({ key: "step1", count: 15, pctOfStart: 100 });
    // The step-1 stoppers show up as the step 1 -> step 2 drop.
    expect(r.body.data.steps[1]).toMatchObject({ key: "step2", count: 5, dropFromPrev: 66.7 });
    const [raw, params] = callsMatching(queryMock, FUNNEL)[0] as [string, unknown[]];
    expect(params).toEqual(["BI", "30"]);
    // The executable SQL (comments stripped) filters on silo and window only.
    const sql = raw.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
    expect(sql).toContain("FROM applications WHERE silo = $1 AND created_at >= now() - ($2 || ' days')::interval )");
    expect(sql).not.toMatch(/Draft application/);
    expect(sql).not.toMatch(/\bname\s*(=|<>|!=)/);
    expect(sql).toContain("count(*)::int AS started");
  });
});
