// BF_SERVER_MARKETING_SOURCE_HYGIENE_v1
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
const get = (url: string) => request(app).get(url).set("Authorization", `Bearer ${token}`);

const SOURCES = /AS source/;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [SOURCES, { rows: [{ source: "google / cpc", started: 10, submitted: 3 }, { source: "direct", started: 4, submitted: 0 }] }],
    // step6 deliberately differs from submitted so the test can tell which one is reported.
    [/FROM applications/, { rows: [{ started: 20, step2: 10, step3: 8, step4: 6, step5: 5, step6: 4, submitted: 3 }] }],
  ]));
});

async function sourceExpression(): Promise<string> {
  const r = await get("/api/marketing/sources");
  expect(r.status).toBe(200);
  const sql = String(callsMatching(queryMock, SOURCES)[0][0]);
  return sql.slice(sql.indexOf("SELECT"), sql.indexOf("AS source"));
}

describe("marketing funnel and sources hygiene", () => {
  it("no longer renders Review and Submitted as two identical rows", async () => {
    const r = await get("/api/marketing/funnel");
    const keys = r.body.data.steps.map((s: { key: string }) => s.key);
    expect(keys).toEqual(["step1", "step2", "step3", "step4", "step5", "submitted"]);
    expect(keys).not.toContain("step6");
  });

  it("keeps the submitted count as the final funnel value", async () => {
    const r = await get("/api/marketing/funnel");
    const last = r.body.data.steps.at(-1);
    expect(last).toMatchObject({ key: "submitted", count: 3, pctOfStart: 15 });
    expect(last.label).toContain("Review");
  });

  it("reports the source rows with their conversion rate", async () => {
    const r = await get("/api/marketing/sources");
    expect(r.body.data.sources).toEqual([
      { source: "google / cpc", started: 10, submitted: 3, conversion: 30 },
      { source: "direct", started: 4, submitted: 0, conversion: 0 },
    ]);
  });

  it("never reports our own domains as an acquisition source", async () => {
    const expr = await sourceExpression();
    expect(expr).toContain("ILIKE ANY (ARRAY['%boreal.financial', '%boreal.insure', '%canadianbusinessfinancing.com'])");
  });

  it("internal referrers fall through to direct", async () => {
    const expr = (await sourceExpression()).replace(/\s+/g, " ");
    expect(expr).toMatch(/canadianbusinessfinancing\.com'\]\) THEN ''/);
    expect(expr).toMatch(/'direct'\s*\)\s*$/);
  });

  it("still prefers an explicit utm_source over the referrer", async () => {
    const expr = await sourceExpression();
    const utm = expr.indexOf("NULLIF(metadata->'attribution'->>'utm_source', '')");
    expect(utm).toBeGreaterThan(-1);
    expect(utm).toBeLessThan(expr.indexOf("'referrer'"));
  });

  it("extracts the host without a regex backreference", async () => {
    const expr = await sourceExpression();
    expect(expr).not.toContain("regexp_replace");
    expect(expr).toContain("split_part(");
  });
});
