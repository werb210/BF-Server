// BF_SERVER_v787_WORKFLOW_ACCESS - Admin and Marketing read and write workflows; Staff reads only;
// lender / referrer / client tokens are refused. People search follows X-Silo.
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
import meetings from "../meetings.js";

function app(user: Record<string, unknown> | null) {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { if (user) req.user = { id: "u-1", userId: "u-1", silo: "BF", ...user }; next(); });
  a.use("/api/automations", automations);
  a.use("/api/meetings", meetings);
  return a;
}

describe("v787 workflow access", () => {
  beforeEach(() => q.mockClear());

  it("Marketing can create, read, update and delete a workflow", async () => {
    const m = app({ role: "Marketing" });
    expect((await request(m).post("/api/automations").send({ name: "Nurture", graph })).status).toBe(200);
    expect((await request(m).get("/api/automations")).status).toBe(200);
    expect((await request(m).get(`/api/automations/${RULE}`)).body.data).toMatchObject({ id: RULE });
    expect((await request(m).patch(`/api/automations/${RULE}`).send({ name: "Renamed" })).status).toBe(200);
    expect((await request(m).delete(`/api/automations/${RULE}`)).body.data).toEqual({ deleted: 1 });
    expect((await request(m).post("/api/automations/lists").send({ name: "Hot" })).status).toBe(200);
    expect((await request(m).post("/api/automations/from-library").send({ key: "no_reply_3_days" })).status).toBe(200);
    expect((await request(m).post(`/api/automations/${RULE}/enroll`).send({ contactId: CONTACT })).status).toBe(200);
  });

  it("Staff can read and enroll; every other write is 403", async () => {
    const s = app({ role: "Staff" });
    expect((await request(s).get("/api/automations")).status).toBe(200);
    expect((await request(s).get(`/api/automations/${RULE}`)).status).toBe(200);
    expect((await request(s).get("/api/automations/library")).status).toBe(200);
    expect((await request(s).post(`/api/automations/${RULE}/validate`).send({})).status).toBe(200);
    expect((await request(s).post("/api/automations").send({ name: "x", graph })).status).toBe(403);
    expect((await request(s).patch(`/api/automations/${RULE}`).send({ name: "y" })).status).toBe(403);
    expect((await request(s).delete(`/api/automations/${RULE}`)).status).toBe(403);
    expect((await request(s).post("/api/automations/lists").send({ name: "Hot" })).status).toBe(403);
    expect((await request(s).post("/api/automations/from-library").send({ key: "no_reply_3_days" })).status).toBe(403);
    expect((await request(s).post("/api/automations/draft-from-text").send({ prompt: "x" })).status).toBe(403);
    // BF_SERVER_v788_STAFF_ENROLL - Staff may manually enroll a contact.
    expect((await request(s).post(`/api/automations/${RULE}/enroll`).send({ contactId: CONTACT })).status).toBe(200);
    expect((await request(s).post(`/api/automations/enrollments/${RULE}/stop`)).status).toBe(403);
  });

  it("client, lender and referrer tokens are rejected", async () => {
    for (const role of ["Lender", "Referrer", "client", "Client"]) {
      const a = app({ role });
      expect((await request(a).get("/api/automations")).status).toBe(403);
      expect((await request(a).post("/api/automations").send({ name: "x", graph })).status).toBe(403);
    }
    expect((await request(app(null)).get("/api/automations")).status).toBe(401);
  });

  it("people search respects X-Silo BI and defaults to BF", async () => {
    const r = await request(app({ role: "Admin" })).get("/api/meetings/people?q=bianca").set("X-Silo", "BI");
    expect(r.status).toBe(200);
    expect(r.body.people.find((p: any) => p.kind === "contact")).toMatchObject({ contactId: CONTACT });
    const call = q.mock.calls.find((c) => String(c[0]).includes("FROM contacts"))!;
    expect(call[0]).toContain("WHERE silo = $2");
    expect(call[1]).toEqual(["%bianca%", "BI"]);
    q.mockClear();
    await request(app({ role: "Admin" })).get("/api/meetings/people?q=bianca");
    expect(q.mock.calls.find((c) => String(c[0]).includes("FROM contacts"))![1]).toEqual(["%bianca%", "BF"]);
  });
});
