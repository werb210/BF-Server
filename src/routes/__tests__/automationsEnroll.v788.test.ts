// BF_SERVER_v788_STAFF_ENROLL - Staff may manually enroll a contact into a workflow; every other
// workflow write stays Admin / Marketing only. Client / lender / referrer tokens are refused.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const RULE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const graph = { triggers: [{ type: "booking.created", filters: [], filterLogic: "all" }], startNodeId: "a", nodes: { a: { id: "a", kind: "action", action: "add_tag", params: { tag: "booked" }, next: null } } };
const RULE_ROW = { id: RULE, name: "Booked", silo: "BF", enabled: false, graph, settings: null, goal: null, trigger_type: "booking.created", conditions: [] };

const q = vi.fn(async (raw: any, p: any[] = []) => {
  const sql = String(typeof raw === "string" ? raw : raw?.text ?? "");
  if (sql.startsWith("DELETE FROM automation_rules")) return { rows: [], rowCount: 1 };
  if (sql.startsWith("INSERT INTO automation_rules")) return { rows: [{ id: RULE, name: p[1], silo: p[0] }] };
  if (sql.startsWith("INSERT INTO automation_lists")) return { rows: [{ id: "l-1", name: p[0], silo: p[1] }] };
  if (sql.includes("FROM automation_rules WHERE id = $1::uuid AND silo = $2")) return { rows: [RULE_ROW] };
  if (sql.startsWith("UPDATE automation_rules SET")) return { rows: [{ ...RULE_ROW, name: p[2] ?? RULE_ROW.name }] };
  if (sql.includes("FROM automation_rules r WHERE silo = $1")) return { rows: [RULE_ROW] };
  if (sql.includes("FROM contacts")) return { rows: [{ contactId: CONTACT, name: "Bianca Insured", email: "b@x.ca", phone: null, company_name: "BI Co" }] };
  return { rows: [] };
});
vi.mock("../../db.js", () => ({ pool: { query: (sql: string, p?: unknown[]) => q(sql, p as any[]) } }));
vi.mock("../../modules/automation/graphEngine.js", () => ({ enrollGraph: async () => "e-1" }));
vi.mock("../../modules/automation/automationEngine.js", () => ({
  defaultDeps: async () => ({ query: q, now: () => new Date() }),
  buildContext: async (_q: unknown, ev: any) => ({ silo: ev.silo, contact_id: ev.contactId, application_id: null }),
  runEnrollment: async () => "completed",
}));
vi.mock("../../middleware/auth.js", async (orig) => {
  const real: any = await orig();
  return { ...real, requireAuth: (_req: any, _res: any, next: any) => next() };
});

import automations from "../automations.js";

function app(user: Record<string, unknown> | null) {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { if (user) req.user = { id: "u-1", userId: "u-1", silo: "BF", ...user }; next(); });
  a.use("/api/automations", automations);
  return a;
}

describe("v788 staff manual enroll", () => {
  beforeEach(() => q.mockClear());

  it("Staff can enroll a contact", async () => {
    const r = await request(app({ role: "Staff" })).post(`/api/automations/${RULE}/enroll`).send({ contactId: CONTACT });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ enrollmentId: "e-1", outcome: "completed" });
  });

  it("Staff still gets 403 on create, update, delete and lists", async () => {
    const s = app({ role: "Staff" });
    expect((await request(s).post("/api/automations").send({ name: "x", graph })).status).toBe(403);
    expect((await request(s).patch(`/api/automations/${RULE}`).send({ name: "y" })).status).toBe(403);
    expect((await request(s).delete(`/api/automations/${RULE}`)).status).toBe(403);
    expect((await request(s).post("/api/automations/lists").send({ name: "Hot" })).status).toBe(403);
    expect((await request(s).delete("/api/automations/lists/l-1")).status).toBe(403);
    expect((await request(s).post(`/api/automations/enrollments/${RULE}/stop`)).status).toBe(403);
  });

  it("Admin and Marketing are unchanged", async () => {
    for (const role of ["Admin", "Marketing"]) {
      const a = app({ role });
      expect((await request(a).post(`/api/automations/${RULE}/enroll`).send({ contactId: CONTACT })).status).toBe(200);
      expect((await request(a).post("/api/automations").send({ name: "Nurture", graph })).status).toBe(200);
      expect((await request(a).patch(`/api/automations/${RULE}`).send({ name: "Renamed" })).status).toBe(200);
      expect((await request(a).delete(`/api/automations/${RULE}`)).status).toBe(200);
      expect((await request(a).post("/api/automations/lists").send({ name: "Hot" })).status).toBe(200);
    }
  });

  it("client, lender and referrer tokens cannot enroll", async () => {
    for (const role of ["Lender", "Referrer", "client", "Client"]) {
      const r = await request(app({ role })).post(`/api/automations/${RULE}/enroll`).send({ contactId: CONTACT });
      expect(r.status).toBe(403);
    }
    expect((await request(app(null)).post(`/api/automations/${RULE}/enroll`).send({ contactId: CONTACT })).status).toBe(401);
  });
});
