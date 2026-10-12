// BF_SERVER_WIZARD_BLOCK_v153
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool, dbQuery: queryMock, runQuery: queryMock, query: queryMock };
});

import marketing from "../marketing.js";
import publicRoutes from "../public.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
app.use("/api/public", publicRoutes);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

const mig = readFileSync(
  resolve(__dirname, "..", "..", "..", "migrations", "2026_08_30_v153_wizard_block_events.sql"), "utf-8");

const block = (body: Record<string, unknown>) => request(app).post("/api/public/wizard-block").send(body);
const params = (re: RegExp) => callsMatching(queryMock, re).map((c) => c[1] as unknown[]);

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/SELECT id::text AS id FROM contacts/, (_s: string, p?: unknown[]) =>
      String(p?.[0]).replace(/\D/g, "").endsWith("4035550101") ? { rows: [{ id: "8d3c0a4e-0000-4000-8000-000000000001" }] } : { rows: [] }],
  ]));
});

describe("the block is recorded when it happens", () => {
  it("has a public endpoint, because the applicant is not identified yet", async () => {
    const r = await block({ reason: "ca_revenue_floor" });
    expect(r.status).toBe(200);
    expect(r.body.data ?? r.body).toMatchObject({ recorded: true });
  });

  it("requires a reason and nothing else", async () => {
    const r = await block({ step: 1 });
    expect(r.status).toBe(400);
    expect(params(/INSERT INTO wizard_block_events/)).toHaveLength(0);
  });

  it("keeps the row even with no application and no contact", async () => {
    await block({ reason: "ca_revenue_floor", country: "CA", monthlyRevenue: "Under $10,000" });
    const [p] = params(/INSERT INTO wizard_block_events/);
    expect(p[0]).toBe("ca_revenue_floor");
    expect(p[4]).toBeNull(); // application_id
    expect(p[5]).toBeNull(); // contact_id
    expect(mig).toContain("application_id  TEXT,");
    expect(mig).toContain("contact_id      TEXT,");
    expect(mig).not.toContain("application_id TEXT NOT NULL");
  });

  it("a database failure is swallowed so the wizard is never blocked by the logger", async () => {
    queryMock.mockImplementation(answerBySql([[/INSERT INTO wizard_block_events/, new Error("db down")]]));
    const r = await block({ reason: "x" });
    expect(r.status).toBe(200);
  });
});

describe("it does not inflate the count", () => {
  it("one row per session per reason", async () => {
    await block({ reason: "r", sessionKey: "sess-1" });
    const [sql] = callsMatching(queryMock, /INSERT INTO wizard_block_events/)[0] as [string];
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(params(/INSERT INTO wizard_block_events/)[0][8]).toBe("sess-1");
    expect(mig).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_wbe_session_reason");
  });
});

describe("it fills in what the wizard never sent", () => {
  it("writes monthlyRevenue onto the application, preserving the rest of metadata", async () => {
    await block({ reason: "r", applicationToken: "app-77", monthlyRevenue: "Under $10,000" });
    const [[sql, p]] = callsMatching(queryMock, /UPDATE applications/) as [string, unknown[]][];
    expect(p).toEqual(["app-77", "Under $10,000"]);
    expect(sql).toContain("'{kyc,monthlyRevenue}'");
    expect(sql).toContain("COALESCE(metadata,'{}'::jsonb)");
    expect(sql).toContain("COALESCE(metadata->'kyc','{}'::jsonb)");
  });

  it("does not touch applications when there is no application", async () => {
    await block({ reason: "r" });
    expect(callsMatching(queryMock, /UPDATE applications/)).toHaveLength(0);
  });

  it("notes it on the CRM timeline when the phone matches a contact", async () => {
    await block({ reason: "ca_revenue_floor", phone: "(403) 555-0101", country: "CA", monthlyRevenue: "Under $10,000" });
    expect(params(/INSERT INTO wizard_block_events/)[0][5]).toBe("8d3c0a4e-0000-4000-8000-000000000001");
    const [[sql, p]] = callsMatching(queryMock, /INSERT INTO crm_notes/) as [string, unknown[]][];
    expect(sql).toContain("INSERT INTO crm_notes (contact_id, body, silo)");
    expect(sql).toContain("($1)::uuid");
    expect(p[0]).toBe("8d3c0a4e-0000-4000-8000-000000000001");
    expect(String(p[1])).toContain("Stopped at the application: ca_revenue_floor");
  });

  it("writes no note when no contact matches", async () => {
    await block({ reason: "r", phone: "+12125550000" });
    expect(callsMatching(queryMock, /INSERT INTO crm_notes/)).toHaveLength(0);
  });
});

describe("the abandoned list can tell a hard stop from a wander-off", () => {
  it("returns the most recent reason", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM applications a\s+LEFT JOIN contacts c/, { rows: [{ id: "a1", step: 1, contact_phone: "+14035550101", block_reason: "ca_revenue_floor" }, { id: "a2", step: 2, contact_phone: "+14035550102", block_reason: null }] }],
    ]));
    const r = await request(app).get("/api/marketing/abandoned").set("Authorization", `Bearer ${token}`);
    expect(r.body.data.items.map((i: any) => i.blockReason)).toEqual(["ca_revenue_floor", null]);
    const sql = String(callsMatching(queryMock, /FROM applications a\s+LEFT JOIN contacts c/)[0][0]).replace(/\s+/g, " ");
    expect(sql).toContain("(SELECT w.reason FROM wizard_block_events w WHERE w.application_id = a.id::text ORDER BY w.created_at DESC LIMIT 1) AS block_reason");
  });
});

describe("migration safety", () => {
  it("is idempotent", () => {
    expect(mig).toContain("CREATE TABLE IF NOT EXISTS wizard_block_events");
    expect((mig.match(/IF NOT EXISTS/g) || []).length).toBe(4);
  });

  it("does not use pg_trgm", () => {
    expect(mig).not.toContain("pg_trgm");
  });
});
