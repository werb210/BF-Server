// BF_SERVER_v828_APPLICATION_ORIGIN - the "Where this came from" panel: lender, broker or referrer, else nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));

import applicationOriginRoutes from "../applicationOrigin.js";
import { applicationOrigin } from "../../services/applicationOrigin.js";

const staff = "Bearer " + jwt.sign({ sub: "u1", role: "Staff" }, process.env.JWT_SECRET as string);
const app = () => { const a = express(); a.use(express.json()); a.use("/api/application-origin", applicationOriginRoutes); return a; };
const appRow = (over: Record<string, unknown> = {}) => ({
  broker_name: null, zip_name: null, uploaded_by: null, imported_at: null, boreal_pct: null, broker_pct: null, terms: null,
  split_status: null, payout_amount: null, payout_paid_on: null, ref_first: null, ref_last: null, ref_company: null,
  ref_email: null, ref_phone: null, contact_created_at: null, ...over,
});
const db = (referral: unknown[], app: unknown[]) => ({ query: vi.fn(answerBySql([
  [/FROM lender_referrals r/, { rows: referral }],
  [/FROM applications a/, { rows: app }],
])) });

beforeEach(() => h.query.mockReset());

describe("where an application came from", () => {
  it("a lender referral, with the referral for Accept / Decline", async () => {
    const out = await applicationOrigin("app1", db([{ id: "r1", lender_name: "Prairie Bank", status: "pending", created_at: "2026-10-19T16:00:00Z" }], []));
    expect(out).toMatchObject({ kind: "lender", partner: "Prairie Bank", sentAt: "2026-10-19T16:00:00.000Z", referral: { id: "r1", status: "pending" } });
  });

  it("a broker file, with the split", async () => {
    const out = await applicationOrigin("app2", db([], [appRow({ broker_name: "Avance", zip_name: "acme.zip", uploaded_by: "broker:9", imported_at: "2026-10-18T12:00:00Z",
      boreal_pct: "60.00", broker_pct: "40.00", terms: "On funding", split_status: "accepted" })]));
    expect(out).toEqual({ kind: "broker", partner: "Avance", sentAt: "2026-10-18T12:00:00.000Z", zipName: "acme.zip", uploadedBy: "broker:9",
      split: { borealPct: 60, partnerPct: 40, terms: "On funding", status: "accepted", payoutAmount: null, payoutPaidOn: null } });
  });

  it("a broker file with no split yet", async () => {
    expect(await applicationOrigin("app2", db([], [appRow({ broker_name: "Avance" })]))).toMatchObject({ kind: "broker", split: null, sentAt: null });
  });

  it("a referred client", async () => {
    const out = await applicationOrigin("app3", db([], [appRow({ ref_first: "Anthony", ref_last: "Allen", ref_company: "Allen Advisory", ref_email: "a@x.ca", ref_phone: "+14035550100", contact_created_at: "2026-10-01T09:00:00Z" })]));
    expect(out).toEqual({ kind: "referrer", partner: "Anthony Allen", company: "Allen Advisory", email: "a@x.ca", phone: "+14035550100", sentAt: "2026-10-01T09:00:00.000Z" });
  });

  it("nothing for a website application, or one that does not exist", async () => {
    expect(await applicationOrigin("app4", db([], [appRow()]))).toBeNull();
    expect(await applicationOrigin("nope", db([], []))).toBeNull();
  });

  it("the route is for staff only", async () => {
    h.query.mockImplementation(answerBySql([[/FROM lender_referrals r/, { rows: [] }], [/FROM applications a/, { rows: [appRow({ broker_name: "Avance" })] }]]));
    const ok = await request(app()).get("/api/application-origin/app2").set("Authorization", staff);
    expect(ok.status).toBe(200);
    expect(ok.body.origin).toMatchObject({ kind: "broker", partner: "Avance" });
    const lender = "Bearer " + jwt.sign({ sub: "lender:1", role: "Lender", lenderId: "1" }, process.env.JWT_SECRET as string);
    expect((await request(app()).get("/api/application-origin/app2").set("Authorization", lender)).status).toBe(403);
    expect((await request(app()).get("/api/application-origin/app2")).status).toBe(401);
  });
});
