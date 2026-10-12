// READINESS_PREFILL_CRM_FALLBACK_v1 - the wizard's phone-based prefill must
// fall back to a returning client's CRM contact + most recent application when
// they have no readiness_sessions row (i.e. they OTP'd straight in and never
// did the marketing-site readiness check). Before this, such clients opened a
// blank wizard even though we already knew them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, type SqlRule } from "./helpers/answerBySql.js";

const query = vi.fn();
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (...a: unknown[]) => query(...a);
  return { ...real, dbQuery: q, pool: { query: q } };
});
import clientRouter from "../routes/client/index.js";

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);
const PHONE = "+17805550100";
const token = (phone: string) => "Bearer " + jwt.sign({ sub: "client:" + phone, role: "client", phone }, process.env.JWT_SECRET as string);

const APP_SQL = /FROM applications a\s+JOIN contacts c ON c\.id = a\.contact_id/;
const appRow = {
  full_name: "Pat Lee", company_name: "Lee Co", email: "pat@lee.co", phone: PHONE, industry: "construction",
  business_location: "AB", funding_type: "term", requested_amount: "50000", purpose_of_funds: "equipment",
  sales_history_years: "3", annual_revenue_range: "$1M-$3M", avg_monthly_revenue_range: "$100k",
  accounts_receivable_range: "0", fixed_assets_value_range: "0", business: null, applicant: null,
};

function answer(rules: SqlRule[]) {
  query.mockImplementation(answerBySql(rules));
}

beforeEach(() => { query.mockReset(); answer([]); });

describe("readiness-prefill CRM fallback", () => {
  it("falls back to the most recent application when no readiness session matches", async () => {
    answer([[/from readiness_sessions/, { rows: [] }], [APP_SQL, { rows: [appRow] }]]);
    const r = await request(app).get(`/api/client/readiness-prefill?phone=${encodeURIComponent(PHONE)}`).set("Authorization", token(PHONE));
    expect(r.status).toBe(200);
    expect(r.body.found).toBe(true);
    const fallback = callsMatching(query, APP_SQL);
    expect(fallback).toHaveLength(1);
    expect(fallback[0][0]).toContain("ORDER BY a.updated_at DESC NULLS LAST, a.created_at DESC");
  });

  it("only runs the fallback on the phone path, keyed on last-10-digit match", async () => {
    answer([[/from readiness_sessions/, { rows: [] }], [APP_SQL, { rows: [appRow] }]]);
    await request(app).get(`/api/client/readiness-prefill?phone=${encodeURIComponent(PHONE)}`).set("Authorization", token(PHONE));
    const [sql, params] = callsMatching(query, APP_SQL)[0] as [string, unknown[]];
    expect(sql).toContain("right(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g'), 10)"); // digits only (v778)
    expect(params).toEqual([PHONE]);

    // Token path: no readiness session means found:false, with no CRM fallback.
    query.mockClear();
    const t = await request(app).get("/api/client/readiness-prefill?token=rs-missing");
    expect(t.body).toEqual({ found: false });
    expect(callsMatching(query, APP_SQL)).toHaveLength(0);
  });

  it("returns the same prefill field shape as the readiness-session path", async () => {
    answer([[/from readiness_sessions/, { rows: [] }], [APP_SQL, { rows: [appRow] }]]);
    const crm = await request(app).get(`/api/client/readiness-prefill?phone=${encodeURIComponent(PHONE)}`).set("Authorization", token(PHONE));
    expect(crm.body.source).toBe("crm");
    expect(crm.body.prefill).toMatchObject({ annualRevenueRange: "$1M-$3M", businessLocation: "AB", requestedAmount: "50000", fullName: "Pat Lee" });

    answer([[/from readiness_sessions/, { rows: [{ full_name: "Pat Lee", annual_revenue_range: "x", business_location: "y", requested_amount: "z" }] }]]);
    const session = await request(app).get("/api/client/readiness-prefill?token=rs-1");
    for (const key of Object.keys(session.body.prefill)) expect(crm.body.prefill).toHaveProperty(key);
  });

  it("still returns found:false when neither a session nor an application exists", async () => {
    answer([]);
    const r = await request(app).get(`/api/client/readiness-prefill?phone=${encodeURIComponent(PHONE)}`).set("Authorization", token(PHONE));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ found: false });
    expect(callsMatching(query, APP_SQL)).toHaveLength(1);
  });
});
