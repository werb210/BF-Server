// BF_SERVER_v789_MAYA_SUMMARY_PORTAL - application-summary returns what the client portal shows.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";
const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const h = vi.hoisted(() => ({ app: {} as Record<string, unknown>, offersSql: "" }));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const query = async (sql: string) => {
    if (/FROM applications WHERE id::text = \$1 LIMIT 1/.test(sql)) {
      return { rows: [{ id: APP_ID, name: "Todd's Grocery", pipeline_state: "Offer", status: "IN_REVIEW", requested_amount: 50000, created_at: "2026-10-01", updated_at: "2026-10-02", currency: "CAD", ...h.app }] };
    }
    if (/FROM offers o\s+LEFT JOIN lender_submissions/.test(sql)) {
      h.offersSql = sql;
      return { rows: [{ lender_name: "Bank A", product_name: "Term Loan", amount: "75000.00", rate_factor: "1.25", term: "12 months", status: "pending", expiry_date: "2026-11-01" }] };
    }
    return { rows: [], rowCount: 0 };
  };
  return { ...real, pool: { query }, runQuery: query, db: { query } };
});
vi.mock("../routes/clientDocumentsNeeded.js", () => ({
  computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }),
}));

import mayaStaff, { clientApplicationUrl } from "../routes/mayaStaff.js";

const app = express(); app.use(express.json()); app.use("/api/maya", mayaStaff);
const svc = "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const summary = () => request(app).post("/api/maya/staff/application-summary").set("Authorization", svc).send({ application_id: APP_ID });

beforeEach(() => { h.app = {}; delete process.env.CLIENT_URL; });

describe("v789 application-summary carries the client portal view", () => {
  it("returns top-level offers from the offers table the mini-portal reads", async () => {
    const r = await summary();
    expect(r.status).toBe(200);
    expect(r.body.offers).toEqual([{ lender_name: "Bank A", product_name: "Term Loan", amount: 75000, rate: "1.25", term: "12 months", status: "pending", expires_at: "2026-11-01" }]);
    expect(h.offersSql).toContain("COALESCE(o.is_archived, false) = false");
  });

  it("derives signature_status the way the portal does", async () => {
    expect((await summary()).body.signature_status).toBe("not_started");
    h.app = { finalized_lenders: 1 };
    expect((await summary()).body.signature_status).toBe("ready");
    h.app = { finalized_lenders: 1, signnow_group_id: "grp-1" };
    expect((await summary()).body.signature_status).toBe("started");
    h.app = { finalized_lenders: 1, signnow_group_id: "grp-1", signnow_app_signed_at: "2026-10-05" };
    expect((await summary()).body.signature_status).toBe("signed");
  });

  it("continuation_url is the client app link resume nudges send", async () => {
    expect((await summary()).body.continuation_url).toBe(`https://client.boreal.financial/application/${APP_ID}`);
    process.env.CLIENT_URL = "https://client.example.test/";
    expect(clientApplicationUrl(APP_ID)).toBe(`https://client.example.test/application/${APP_ID}`);
  });
});
