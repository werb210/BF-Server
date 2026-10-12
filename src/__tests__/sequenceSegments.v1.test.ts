// BF_SERVER_SEQUENCE_SEGMENTS_v1 - sequence steps may send email or SMS, so the
// sequence audience counts every contact reachable through either channel.
import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { SMS_ELIGIBLE_SQL, CONSENT_SQL } from "../services/smsConsent.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});

import marketing from "../routes/marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const get = (url: string, silo = "BF") => request(app).get(url).set("Authorization", `Bearer ${token}`).set("X-Silo", silo);

const CONTACT_QUERIES = /FROM contacts c/;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/SELECT tag, count/, { rows: [{ tag: "vip", n: 4 }] }],
    [/SELECT count\(\*\)::int AS n FROM contacts c/, { rows: [{ n: 9 }] }],
  ]));
});

describe("sequence audience segments", () => {
  it("returns the reachable total and the tag segments", async () => {
    const r = await get("/api/marketing/segments");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ all: 9, segments: [{ tag: "vip", n: 4 }] });
  });

  it("counts anyone reachable by email OR sms, not just textable contacts", async () => {
    await get("/api/marketing/segments");
    const calls = callsMatching(queryMock, CONTACT_QUERIES);
    expect(calls).toHaveLength(2);
    for (const [sql] of calls) {
      expect(String(sql)).toContain("(COALESCE(c.email,'') <> '' OR COALESCE(c.phone,'') <> '')");
      expect(String(sql)).not.toContain(SMS_ELIGIBLE_SQL.trim());
      expect(String(sql)).not.toContain("sms_opt_out");
      expect(String(sql)).not.toContain(CONSENT_SQL);
    }
  });

  it("still honours the opt-out flag", async () => {
    await get("/api/marketing/segments");
    for (const [sql] of callsMatching(queryMock, CONTACT_QUERIES)) {
      expect(String(sql)).toContain("COALESCE(c.marketing_opt_out,false) = false");
    }
  });

  it("is silo-scoped like every other segments endpoint", async () => {
    await get("/api/marketing/segments", "BI");
    for (const [sql, params] of callsMatching(queryMock, CONTACT_QUERIES)) {
      expect(String(sql)).toContain("c.silo = $1");
      expect(params).toEqual(["BI"]);
    }
  });

  it("does not disturb the SMS-specific segments endpoint, which stays on SMS eligibility", async () => {
    const r = await get("/api/marketing/sms/segments");
    expect(r.status).toBe(200);
    const sqls = callsMatching(queryMock, CONTACT_QUERIES).map((c) => String(c[0]));
    expect(sqls.filter((s) => s.includes(SMS_ELIGIBLE_SQL))).toHaveLength(2);
  });
});
