// BF_SERVER_ABANDONED_REVENUE_v148
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { queryMock, rows } = vi.hoisted(() => ({ queryMock: vi.fn(), rows: [] as Array<Record<string, unknown>> }));
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
const ABANDONED = /FROM applications a\s+LEFT JOIN contacts c/;

const UNDER = "Under $10,000";
const row = (id: string, o: Record<string, unknown>) => ({
  id, step: 1, created_at: "2026-10-01", updated_at: "2026-10-02", requested_amount: null, product_category: null,
  contact_id: "c-" + id, contact_name: "N " + id, contact_phone: null, contact_email: null, gclid: null, utm_source: null,
  utm_campaign: null, kyc_location: null, business_state: null, kyc_monthly_revenue: null, block_reason: null, abandon_sms_sent_at: null, ...o,
});

async function list() {
  const r = await request(app).get("/api/marketing/abandoned").set("Authorization", `Bearer ${token}`);
  expect(r.status).toBe(200);
  const byId = Object.fromEntries(r.body.data.items.map((i: any) => [i.applicationId, i]));
  return { data: r.body.data, byId };
}

beforeEach(() => {
  rows.length = 0;
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([[ABANDONED, () => ({ rows })]]));
});

describe("the answer that stopped them is returned", () => {
  it("selects monthlyRevenue from the kyc slice", async () => {
    await list();
    expect(String(callsMatching(queryMock, ABANDONED)[0][0])).toContain("NULLIF(a.metadata->'kyc'->>'monthlyRevenue','')     AS kyc_monthly_revenue");
  });

  it("exposes it on each row, null when not given", async () => {
    rows.push(row("a1", { kyc_monthly_revenue: "$10,000 - $30,000" }), row("a2", {}));
    const { byId } = await list();
    expect(byId.a1.monthlyRevenue).toBe("$10,000 - $30,000");
    expect(byId.a2.monthlyRevenue).toBeNull();
  });
});

describe("a hard stop is distinguished from an abandonment", () => {
  it("flags the Canadian floor when the country is Canada and revenue is under $10,000", async () => {
    rows.push(
      row("ca", { kyc_location: "Canada", kyc_monthly_revenue: UNDER }),
      row("ca-state", { business_state: "AB", kyc_monthly_revenue: ` ${UNDER} ` }),
      row("ca-phone", { contact_phone: "+14035550101", kyc_monthly_revenue: UNDER }),
    );
    const { byId } = await list();
    expect(byId.ca.belowCanadianFloor).toBe(true);
    expect(byId["ca-state"].belowCanadianFloor).toBe(true);
    // An area-code country is the only signal for someone who typed nothing.
    expect(byId["ca-phone"]).toMatchObject({ country: "CA", countryInferred: true, belowCanadianFloor: true });
  });

  it("matches the threshold the wizard enforces: other revenue answers or other countries are callable", async () => {
    rows.push(
      row("us", { kyc_location: "United States", kyc_monthly_revenue: UNDER }),
      row("ca-more", { kyc_location: "Canada", kyc_monthly_revenue: "$10,000 - $30,000" }),
    );
    const { byId } = await list();
    expect(byId.us.belowCanadianFloor).toBe(false);
    expect(byId["ca-more"].belowCanadianFloor).toBe(false);
  });

  it("requires both facts, so a null country or a missing revenue never marks someone unfundable", async () => {
    rows.push(
      row("no-country", { kyc_monthly_revenue: UNDER }),
      row("no-revenue", { kyc_location: "Canada" }),
    );
    const { byId } = await list();
    expect(byId["no-country"].country).toBeNull();
    expect(byId["no-country"].belowCanadianFloor).toBe(false);
    expect(byId["no-revenue"].belowCanadianFloor).toBe(false);
  });

  it("counts what is actually callable", async () => {
    rows.push(
      row("ca", { kyc_location: "Canada", kyc_monthly_revenue: UNDER }),
      row("us", { kyc_location: "United States", kyc_monthly_revenue: UNDER }),
      row("x", {}),
    );
    const { data } = await list();
    expect(data).toMatchObject({ count: 3, belowCanadianFloor: 1, callable: 2 });
  });
});
