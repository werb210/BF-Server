// BF_SERVER_v786_WORKFLOW_GRAPH - workflow endpoints: catalog, CRUD with validation, validate,
// performance, history, library, manual enroll, draft-from-text (OpenAI mocked).
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const RULE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TPL = "11111111-1111-4111-8111-111111111111";
const goodGraph = { triggers: [{ type: "booking.created", filters: [], filterLogic: "all" }], startNodeId: "a", nodes: { a: { id: "a", kind: "action", action: "add_tag", params: { tag: "booked" }, next: null } } };
const badGraph = { triggers: [{ type: "booking.created", filters: [] }], startNodeId: "a", nodes: { a: { id: "a", kind: "action", action: "send_email", params: {}, next: "gone" } } };

const db = { rule: null as any, inserts: [] as any[], updates: [] as any[] };
const q = vi.fn(async (sql: string, p: any[] = []) => {
  if (sql.includes("FROM marketing_template WHERE silo = $1")) return { rows: [{ id: TPL, name: "Welcome", channel: "email" }, { id: "t-sms", name: "Nudge", channel: "sms" }] };
  if (sql.includes("FROM automation_lists WHERE silo = $1 ORDER BY name")) return { rows: [{ id: "l-1", name: "Hot leads" }] };
  if (sql.includes("SELECT id::text AS id, name FROM automation_rules WHERE silo = $1")) return { rows: [{ id: RULE, name: "Booked" }] };
  if (sql.startsWith("INSERT INTO automation_rules")) { db.inserts.push(p); return { rows: [{ id: RULE, name: p[1], silo: p[0], enabled: p.includes(true) }] }; }
  if (sql.includes("FROM automation_rules WHERE id = $1::uuid AND silo = $2")) return { rows: db.rule ? [db.rule] : [] };
  if (sql.startsWith("UPDATE automation_rules SET")) { db.updates.push(p); return { rows: [{ ...db.rule, enabled: p[6] ?? db.rule.enabled }] }; }
  if (sql.includes("SELECT id FROM automation_rules WHERE id = $1::uuid")) return { rows: db.rule ? [{ id: RULE }] : [] };
  if (sql.includes("count(*) FILTER (WHERE goal_reached_at IS NOT NULL)") && sql.includes("test_mode = false")) return { rows: [{ enrolled: 7, active: 2, completed: 5, goal_reached: 3 }] };
  if (sql.includes("FROM automation_step_log l JOIN automation_enrollments e") && sql.includes("e.test_mode = false") && sql.includes("GROUP BY l.node_id")) return { rows: [{ node_id: "a", entered: 7, failed: 1 }, { node_id: "b", entered: 4, failed: 0 }] };
  if (sql.includes("FROM automation_enrollments e LEFT JOIN contacts c") && sql.includes("e.path")) {
    return { rows: [{ id: "e-1", status: "completed", contact_id: p[2] ?? CONTACT, path: [{ nodeId: "a", kind: "action", at: "2026-10-11T18:00:00Z", result: "tag booked" }] }] };
  }
  return { rows: [] };
});
vi.mock("../../db.js", () => ({ pool: { query: (sql: string, p?: unknown[]) => q(sql, p as any[]) } }));

const enrollGraph = vi.fn(async () => "e-77");
vi.mock("../../modules/automation/graphEngine.js", () => ({ enrollGraph: (...a: any[]) => (enrollGraph as any)(...a) }));
vi.mock("../../modules/automation/automationEngine.js", () => ({
  defaultDeps: async () => ({ query: q, now: () => new Date() }),
  buildContext: async (_q: unknown, ev: any) => ({ silo: ev.silo, contact_id: ev.contactId, application_id: null }),
  runEnrollment: async () => "completed",
}));
const create = vi.fn();
vi.mock("openai", () => ({ default: class { chat = { completions: { create: (...a: any[]) => create(...a) } }; } }));

import router from "../automations.js";

function app(role = "Admin") {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.user = { id: "u-1", userId: "u-1", role, silo: "BF" }; next(); });
  a.use("/api/automations", router);
  return a;
}

describe("automation endpoints", () => {
  beforeEach(() => { db.rule = { id: RULE, name: "Booked", silo: "BF", enabled: false, graph: badGraph, settings: null, goal: null, trigger_type: "booking.created", conditions: [] }; db.inserts = []; db.updates = []; });

  it("GET /catalog returns triggers, actions, fields, templates, lists and workflows", async () => {
    const r = await request(app("Staff")).get("/api/automations/catalog");
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.triggers.find((t: any) => t.type === "booking.created")).toMatchObject({ label: expect.any(String), group: "Meetings", filterFields: expect.any(Array) });
    expect(d.actions.find((a: any) => a.action === "send_email").params[0]).toMatchObject({ key: "templateId", required: true });
    expect(d.fields.some((f: any) => f.key === "sms.replied")).toBe(true);
    expect(d.templates).toEqual({ email: [{ id: TPL, name: "Welcome" }], sms: [{ id: "t-sms", name: "Nudge" }] });
    expect(d.lists).toEqual([{ id: "l-1", name: "Hot leads" }]);
    expect(d.workflows).toEqual([{ id: RULE, name: "Booked" }]);
  });

  it("POST /:id/validate lists issues per node", async () => {
    const r = await request(app("Staff")).post(`/api/automations/${RULE}/validate`).send({});
    expect(r.status).toBe(200);
    expect(r.body.data.issues).toEqual([{ nodeId: "a", message: "pick an email template" }, { nodeId: "a", message: "next points to a step that does not exist" }]);
    const ok = await request(app("Staff")).post(`/api/automations/${RULE}/validate`).send({ graph: goodGraph });
    expect(ok.body.data.issues).toEqual([]);
  });

  it("saving with issues is allowed, enabling is refused; writes are Admin only", async () => {
    const saved = await request(app()).post("/api/automations").send({ name: "Draft", graph: badGraph, enabled: false });
    expect(saved.status).toBe(200);
    expect(saved.body.data.issues).toHaveLength(2);
    const refused = await request(app()).post("/api/automations").send({ name: "Live", graph: badGraph, enabled: true });
    expect(refused.status).toBe(422);
    expect(refused.body.issues).toHaveLength(2);
    const patch = await request(app()).patch(`/api/automations/${RULE}`).send({ enabled: true });
    expect(patch.status).toBe(422);
    const fixed = await request(app()).patch(`/api/automations/${RULE}`).send({ graph: goodGraph, enabled: true, settings: { reenroll: "always" }, silo: "BF" });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.issues).toEqual([]);
    expect(db.updates[0][9]).toBe(JSON.stringify(goodGraph));
    expect((await request(app("Staff")).post("/api/automations").send({ name: "x", graph: goodGraph })).status).toBe(403);
    expect((await request(app("Staff")).delete(`/api/automations/${RULE}`)).status).toBe(403);
  });

  it("GET /:id/performance and /:id/history", async () => {
    const perf = await request(app("Staff")).get(`/api/automations/${RULE}/performance`);
    expect(perf.body.data).toEqual({ enrolled: 7, active: 2, completed: 5, goalReached: 3, byNode: { a: { entered: 7, failed: 1 }, b: { entered: 4, failed: 0 } } });
    const hist = await request(app("Staff")).get(`/api/automations/${RULE}/history?contactId=${CONTACT}&limit=5`);
    expect(hist.body.data[0]).toMatchObject({ id: "e-1", contact_id: CONTACT, path: [{ nodeId: "a" }] });
    const call = q.mock.calls.find((c) => String(c[0]).includes("e.path"))!;
    expect(call[1]).toEqual([RULE, "BF", CONTACT, 5]);
  });

  it("library and from-library", async () => {
    const lib = await request(app("Staff")).get("/api/automations/library");
    expect(lib.body.data).toHaveLength(6);
    const made = await request(app()).post("/api/automations/from-library").send({ key: "no_reply_3_days" });
    expect(made.status).toBe(200);
    expect(db.inserts[0][1]).toBe("No reply after 3 days");
    expect(JSON.parse(db.inserts[0][8]).triggers[0].type).toBe("no_reply");
  });

  it("POST /:id/enroll enrolls a contact by hand", async () => {
    db.rule.graph = goodGraph;
    const r = await request(app("Marketing")).post(`/api/automations/${RULE}/enroll`).send({ contactId: CONTACT });
    expect(r.body.data).toEqual({ enrollmentId: "e-77", outcome: "completed" });
    expect(enrollGraph).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: RULE }), expect.objectContaining({ contact_id: CONTACT }), { ignoreReenroll: true });
  });

  it("POST /draft-from-text builds a validated draft with gpt-4o, and refuses an invalid one", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    create.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ name: "Booked follow-up", graph: goodGraph, settings: { reenroll: "never" }, goal: null }) } }] });
    const ok = await request(app()).post("/api/automations/draft-from-text").send({ prompt: "tag people who book a call", silo: "BF" });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ name: "Booked follow-up", graph: goodGraph, settings: { reenroll: "never" }, goal: null });
    const body = create.mock.calls[0][0];
    expect(body.model).toBe("gpt-4o");
    expect(body.messages[0].content).toContain("booking.created");
    expect(body.messages[0].content).toContain(TPL);
    create.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ name: "Bad", graph: badGraph }) } }] });
    const bad = await request(app()).post("/api/automations/draft-from-text").send({ prompt: "email them" });
    expect(bad.status).toBe(422);
    expect(bad.body.issues.map((i: any) => i.nodeId)).toEqual(["a", "a"]);
    create.mockResolvedValueOnce({ choices: [{ message: { content: "not json" } }] });
    expect((await request(app()).post("/api/automations/draft-from-text").send({ prompt: "x" })).status).toBe(422);
    delete process.env.OPENAI_API_KEY;
    expect((await request(app()).post("/api/automations/draft-from-text").send({ prompt: "x" })).status).toBe(503);
  });

  it("lists: GET / POST / DELETE", async () => {
    expect((await request(app()).post("/api/automations/lists").send({ name: "" })).status).toBe(400);
    await request(app()).post("/api/automations/lists").send({ name: "Webinar" });
    expect(q.mock.calls.some((c) => String(c[0]).startsWith("INSERT INTO automation_lists") && (c[1] as any[])[0] === "Webinar")).toBe(true);
    expect((await request(app("Staff")).get("/api/automations/lists")).status).toBe(200);
    expect((await request(app()).delete("/api/automations/lists/l-1")).status).toBe(400);
  });
});
