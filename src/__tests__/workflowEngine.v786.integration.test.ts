// BF_SERVER_v786_WORKFLOW_GRAPH - the v2 workflow engine against a real Postgres: enroll on an event,
// park on until_event, resume on the event, branch, create a task, write the step log and timeline;
// the loop guard; the daily no_reply / date.relative triggers; v1 -> v2 conversion on startup.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import { dispatchEvent, runEnrollment, type EngineDeps } from "../modules/automation/automationEngine.js";
import { convertV1Rules, runDailyTriggers } from "../modules/automation/graphEngine.js";

const tag = "v786" + Math.floor(Math.random() * 1e6);
const userId = randomUUID();
const contactId = randomUUID();
const rules: string[] = [];
const deps: EngineDeps = {
  query: (sql, params) => pool.query(sql, params as any[]) as any,
  now: () => new Date(),
  sendSms: vi.fn(async () => undefined),
  notifyClient: vi.fn(async () => "app" as const),
};
const settings = { reenroll: "always", quietHours: { enabled: false, start: "09:00", end: "20:00", tz: "America/Edmonton" }, unenrollOnGoal: true, testMode: false };

async function makeRule(name: string, graph: unknown, extra: { goal?: unknown; graphNull?: boolean; steps?: unknown; trigger?: string } = {}): Promise<string> {
  const r = await pool.query(
    `INSERT INTO automation_rules (silo, name, trigger_type, conditions, actions, steps, enabled, reenroll, graph, settings, goal, schema_version)
     VALUES ('BF', $1, $2, '[]'::jsonb, '[]'::jsonb, $3::jsonb, true, 'always', $4::jsonb, $5::jsonb, $6::jsonb, $7) RETURNING id::text AS id`,
    [name + " " + tag, extra.trigger ?? "manual", JSON.stringify(extra.steps ?? []), extra.graphNull ? null : JSON.stringify(graph), extra.graphNull ? null : JSON.stringify(settings),
     extra.goal ? JSON.stringify(extra.goal) : null, extra.graphNull ? 1 : 2]);
  rules.push(r.rows[0].id);
  return r.rows[0].id;
}
const enrollmentsOf = async (ruleId: string) => (await pool.query(`SELECT * FROM automation_enrollments WHERE rule_id = $1::uuid ORDER BY created_at`, [ruleId])).rows;

describe("v786 workflow engine (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(readFileSync("migrations/2026_10_11_workflow_graph.sql", "utf8"));
    await pool.query(`INSERT INTO users (id, email, role, active) VALUES ($1, $2, 'Staff', true)`, [userId, `${tag}@boreal.financial`]);
    await pool.query(`INSERT INTO contacts (id, name, first_name, phone, silo, tags, owner_id, lead_status) VALUES ($1, $2, 'Pat', '+17805550000', 'BF', ARRAY[$3], $4, 'Hot')`, [contactId, "Pat " + tag, tag, userId]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM tasks WHERE contact_id = $1::uuid`, [contactId]);
    await pool.query(`DELETE FROM automation_rules WHERE id = ANY($1::uuid[])`, [rules]);
    await pool.query(`DELETE FROM automation_daily_fires WHERE contact_id = $1::uuid`, [contactId]);
    await pool.query(`DELETE FROM crm_timeline_events WHERE contact_id = $1::uuid`, [contactId]);
    await pool.query(`DELETE FROM communications_messages WHERE contact_id = $1::uuid`, [contactId]);
    await pool.query(`DELETE FROM contacts WHERE id = $1::uuid`, [contactId]);
    await pool.query(`DELETE FROM users WHERE id = $1::uuid`, [userId]);
  });

  it("enrolls on an event, waits for another, resumes, branches and creates the task", async () => {
    const ruleId = await makeRule("booked", {
      triggers: [{ type: "booking.created", filters: [{ field: "contact_tag", op: "contains", value: tag }], filterLogic: "all" }],
      startNodeId: "t1",
      nodes: {
        t1: { id: "t1", kind: "action", action: "add_tag", params: { tag: tag + "_booked" }, next: "w" },
        w: { id: "w", kind: "delay", mode: "until_event", params: { event: "message.inbound", timeoutAmount: 2, timeoutUnit: "days" }, next: "b", timeoutNext: null },
        b: { id: "b", kind: "branch", branches: [{ id: "hot", label: "Hot", logic: "all", conditions: [{ field: "lead_status", op: "eq", value: "hot" }], next: "task" }], noneNext: null },
        task: { id: "task", kind: "action", action: "create_task", params: { title: "Call {{first_name}} " + tag, type: "call", priority: "high", dueInHours: 1, assignee: "owner" }, next: null },
      },
    });
    const ids = await dispatchEvent(deps, { trigger: "booking.created", silo: "BF", contactId, data: {} });
    expect(ids).toHaveLength(1);
    let [e] = await enrollmentsOf(ruleId);
    expect(e).toMatchObject({ status: "active", schema_version: 2, current_node_id: "w", wait_event: "message.inbound" });
    expect(new Date(e.next_run_at).getTime()).toBe(new Date(e.wait_timeout_at).getTime());
    expect(e.path.map((p: any) => p.nodeId)).toEqual(["t1", "w"]);
    const c = await pool.query(`SELECT tags FROM contacts WHERE id = $1`, [contactId]);
    expect(c.rows[0].tags).toContain(tag + "_booked");
    expect(await runEnrollment(deps, e.id)).toBe("not_due");

    await dispatchEvent(deps, { trigger: "message.inbound", silo: "BF", contactId, data: { channel: "sms" } });
    [e] = await enrollmentsOf(ruleId);
    expect(e.status).toBe("completed");
    expect(e.path.map((p: any) => p.nodeId)).toEqual(["t1", "w", "w", "b", "task"]);
    const t = await pool.query(`SELECT title, type, priority, source, assignee_user_id::text AS a FROM tasks WHERE contact_id = $1`, [contactId]);
    expect(t.rows).toEqual([{ title: "Call Pat " + tag, type: "CALL", priority: "HIGH", source: "WORKFLOW", a: userId }]);
    const log = await pool.query(`SELECT node_id, outcome FROM automation_step_log WHERE enrollment_id = $1 ORDER BY id`, [e.id]);
    expect(log.rows.map((r) => r.node_id)).toEqual(["t1", "w", "w", "b", "task"]);
    const tl = await pool.query(`SELECT count(*)::int AS n FROM crm_timeline_events WHERE contact_id = $1 AND event_type = 'automation'`, [contactId]);
    expect(tl.rows[0].n).toBe(5);
  });

  it("stops a loop with no delay at 200 steps", async () => {
    const ruleId = await makeRule("loop", {
      triggers: [{ type: "manual", filters: [] }], startNodeId: "a",
      nodes: { a: { id: "a", kind: "branch", branches: [{ id: "x", conditions: [{ field: "first_name", op: "eq", value: "Pat" }], next: "g" }], noneNext: null }, g: { id: "g", kind: "goto", target: "a" } },
    });
    const { enrollContactInRule } = await import("../modules/automation/graphEngine.js");
    const id = await enrollContactInRule(deps, ruleId, { silo: "BF", contactId });
    expect(await runEnrollment(deps, id!)).toBe("failed");
    const [e] = await enrollmentsOf(ruleId);
    expect(e).toMatchObject({ status: "failed", last_error: "loop_guard", steps_today: 201 });
  });

  it("runs the daily no_reply and date.relative triggers once per day", async () => {
    await pool.query(`INSERT INTO communications_messages (id, type, direction, contact_id, body, silo, created_at) VALUES (gen_random_uuid(), 'sms', 'outbound', $1, 'hi', 'BF', now() - interval '3 days')`, [contactId]);
    const noReply = await makeRule("noreply", { triggers: [{ type: "no_reply", filters: [], params: { days: 3 } }], startNodeId: "d", nodes: { d: { id: "d", kind: "delay", mode: "duration", params: { amount: 1, unit: "days" }, next: null } } });
    const dated = await makeRule("dated", { triggers: [{ type: "date.relative", filters: [{ field: "contact_tag", op: "contains", value: tag }], params: { field: "created_at", offsetDays: 0, time: "00:00" } }], startNodeId: "d", nodes: { d: { id: "d", kind: "delay", mode: "duration", params: { amount: 1, unit: "days" }, next: null } } });
    await runDailyTriggers(deps);
    await runDailyTriggers(deps);
    expect((await enrollmentsOf(noReply)).map((e) => e.contact_id)).toEqual([contactId]);
    expect((await enrollmentsOf(dated)).map((e) => e.contact_id)).toEqual([contactId]);
  });

  it("converts v1 rules to graphs on startup, once, keeping the steps", async () => {
    const steps = [{ type: "wait", amount: 1, unit: "hours" }, { type: "add_tag", tag: "x" }];
    const ruleId = await makeRule("v1", null, { graphNull: true, steps, trigger: "call.missed" });
    expect(await convertV1Rules(deps.query)).toBeGreaterThanOrEqual(1);
    const r = (await pool.query(`SELECT graph, settings, schema_version, steps FROM automation_rules WHERE id = $1`, [ruleId])).rows[0];
    expect(r.schema_version).toBe(2);
    expect(r.graph.triggers[0].type).toBe("call.missed");
    expect(r.graph.nodes.n1).toMatchObject({ kind: "delay", next: "n2" });
    expect(r.steps).toEqual(steps);
    expect(await convertV1Rules(deps.query)).toBe(0);
  });
});
