// BF_SERVER_v792_WORKFLOW_TEST_RUN - a test run from the builder (POST /api/automations/:id/enroll with
// testMode: true) walks the whole workflow at once against a real Postgres: waits are skipped and
// logged as dry runs, branches read the real contact, actions are dry runs, and the step log comes
// back in the response. Real enrollments still wait. Test runs do not count toward performance.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import automations from "../routes/automations.js";

const tag = "v792" + Math.floor(Math.random() * 1e6);
const contactId = randomUUID();
const rules: string[] = [];
const settings = { reenroll: "always", quietHours: { enabled: true, start: "09:00", end: "09:01", tz: "America/Edmonton" }, unenrollOnGoal: true, testMode: false };

async function makeRule(name: string, graph: unknown, goal: unknown = null): Promise<string> {
  const r = await pool.query(
    `INSERT INTO automation_rules (silo, name, trigger_type, conditions, actions, steps, enabled, reenroll, graph, settings, goal, schema_version)
     VALUES ('BF', $1, 'manual', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, false, 'always', $2::jsonb, $3::jsonb, $4::jsonb, 2) RETURNING id::text AS id`,
    [name + " " + tag, JSON.stringify(graph), JSON.stringify(settings), goal ? JSON.stringify(goal) : null]);
  rules.push(r.rows[0].id);
  return r.rows[0].id;
}

function app(role: string) {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.user = { id: "u-1", userId: "u-1", role, silo: "BF" }; next(); });
  a.use("/api/automations", automations);
  return a;
}
const enroll = (ruleId: string, body: Record<string, unknown>, role = "Staff") => request(app(role)).post(`/api/automations/${ruleId}/enroll`).send(body);

describe("v792 workflow test runs (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(readFileSync("migrations/2026_10_11_workflow_graph.sql", "utf8"));
    await pool.query(`INSERT INTO contacts (id, name, first_name, phone, silo, tags, lead_status) VALUES ($1, $2, 'Pat', '+17805550001', 'BF', ARRAY[$3], 'Hot')`, [contactId, "Pat " + tag, tag]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM tasks WHERE contact_id = $1::uuid`, [contactId]);
    await pool.query(`DELETE FROM automation_rules WHERE id = ANY($1::uuid[])`, [rules]);
    await pool.query(`DELETE FROM crm_timeline_events WHERE contact_id = $1::uuid`, [contactId]);
    await pool.query(`DELETE FROM contacts WHERE id = $1::uuid`, [contactId]);
  });

  it("runs trigger -> email -> wait 2 days -> branch -> task to the end in one call, while Off", async () => {
    const ruleId = await makeRule("full", {
      triggers: [{ type: "manual", filters: [] }], startNodeId: "email",
      nodes: {
        email: { id: "email", kind: "action", action: "send_email", params: { templateId: randomUUID() }, next: "wait" },
        wait: { id: "wait", kind: "delay", mode: "duration", params: { amount: 2, unit: "days" }, next: "b" },
        b: { id: "b", kind: "branch", branches: [{ id: "hot", label: "Hot", logic: "all", conditions: [{ field: "lead_status", op: "eq", value: "hot" }], next: "task" }], noneNext: null },
        task: { id: "task", kind: "action", action: "create_task", params: { title: "Call {{first_name}}", type: "call", priority: "high", dueInHours: 1, assignee: "owner" }, next: null },
      },
    }, { logic: "all", conditions: [{ field: "lead_status", op: "eq", value: "hot" }] });
    for (const role of ["Admin", "Marketing", "Staff"]) {
      const r = await enroll(ruleId, { contactId, testMode: true }, role);
      expect(r.status).toBe(200);
      const d = r.body.data;
      expect(d).toMatchObject({ enrollmentId: expect.any(String), outcome: "completed", testMode: true });
      expect(d.steps.map((s: any) => [s.step_index, s.node_id, s.step_type, s.outcome])).toEqual([
        [0, "email", "send_email", "dry_run"],
        [1, "wait", "delay", "dry_run"],
        [2, "b", "branch", "done"],
        [3, "task", "create_task", "dry_run"],
      ]);
      expect(d.steps[1].detail).toBe("would wait 2 days");
      expect(d.steps[2].detail).toBe("path Hot");
      expect(d.steps[3].detail).toBe("would run: Call Pat");
      const e = (await pool.query(`SELECT status, test_mode, next_run_at FROM automation_enrollments WHERE id = $1::uuid`, [d.enrollmentId])).rows[0];
      expect(e).toMatchObject({ status: "completed", test_mode: true });
    }
    const t = await pool.query(`SELECT count(*)::int AS n FROM tasks WHERE contact_id = $1::uuid`, [contactId]);
    expect(t.rows[0].n).toBe(0);
  });

  it("an until_event wait follows the timeout path; until_time names the day", async () => {
    const ruleId = await makeRule("event", {
      triggers: [{ type: "manual", filters: [] }], startNodeId: "w",
      nodes: {
        w: { id: "w", kind: "delay", mode: "until_event", params: { event: "message.inbound", timeoutAmount: 1, timeoutUnit: "days" }, next: "replied", timeoutNext: "t" },
        replied: { id: "replied", kind: "action", action: "add_tag", params: { tag: "replied" }, next: null },
        t: { id: "t", kind: "delay", mode: "until_time", params: { time: "09:00", weekdays: [1], tz: "America/Edmonton" }, next: "nudge" },
        nudge: { id: "nudge", kind: "action", action: "add_tag", params: { tag: "nudged" }, next: null },
      },
    });
    const r = await enroll(ruleId, { contactId, testMode: true });
    expect(r.body.data.outcome).toBe("completed");
    const steps = r.body.data.steps;
    expect(steps.map((s: any) => s.node_id)).toEqual(["w", "t", "nudge"]);
    expect(steps[0]).toMatchObject({ outcome: "dry_run", detail: "would wait for message.inbound (up to 1 day); test continues as if it did not happen" });
    expect(steps[1]).toMatchObject({ outcome: "dry_run", detail: "would wait until Mon 09:00" });
    const c = await pool.query(`SELECT tags FROM contacts WHERE id = $1::uuid`, [contactId]);
    expect(c.rows[0].tags).not.toContain("nudged");
  });

  it("a test run stops a loop at 200 steps", async () => {
    const ruleId = await makeRule("loop", {
      triggers: [{ type: "manual", filters: [] }], startNodeId: "a",
      nodes: { a: { id: "a", kind: "delay", mode: "duration", params: { amount: 1, unit: "hours" }, next: "g" }, g: { id: "g", kind: "goto", target: "a" } },
    });
    const r = await enroll(ruleId, { contactId, testMode: true });
    expect(r.body.data.outcome).toBe("stopped");
    expect(r.body.data.steps).toHaveLength(201);
    expect(r.body.data.steps[200]).toMatchObject({ outcome: "stopped", detail: "stopped: too many steps" });
    const e = (await pool.query(`SELECT status FROM automation_enrollments WHERE id = $1::uuid`, [r.body.data.enrollmentId])).rows[0];
    expect(e.status).toBe("stopped");
  });

  it("a real enrollment still waits, and performance ignores test runs", async () => {
    const ruleId = await makeRule("real", {
      triggers: [{ type: "manual", filters: [] }], startNodeId: "tagit",
      nodes: {
        tagit: { id: "tagit", kind: "action", action: "add_tag", params: { tag: tag + "_real" }, next: "wait" },
        wait: { id: "wait", kind: "delay", mode: "duration", params: { amount: 2, unit: "days" }, next: "tag2" },
        tag2: { id: "tag2", kind: "action", action: "add_tag", params: { tag: tag + "_later" }, next: null },
      },
    });
    const real = await enroll(ruleId, { contactId });
    expect(real.body.data).toEqual({ enrollmentId: expect.any(String), outcome: "waiting" });
    const e = (await pool.query(`SELECT status, current_node_id, next_run_at FROM automation_enrollments WHERE id = $1::uuid`, [real.body.data.enrollmentId])).rows[0];
    expect(e).toMatchObject({ status: "active", current_node_id: "tag2" });
    expect(new Date(e.next_run_at).getTime()).toBeGreaterThan(Date.now() + 86_400_000);
    const c = await pool.query(`SELECT tags FROM contacts WHERE id = $1::uuid`, [contactId]);
    expect(c.rows[0].tags).toContain(tag + "_real");
    expect(c.rows[0].tags).not.toContain(tag + "_later");

    const test1 = await enroll(ruleId, { contactId, testMode: true });
    const test2 = await enroll(ruleId, { contactId, testMode: true });
    expect([test1.body.data.outcome, test2.body.data.outcome]).toEqual(["completed", "completed"]);
    const perf = await request(app("Staff")).get(`/api/automations/${ruleId}/performance`);
    expect(perf.body.data).toEqual({ enrolled: 1, active: 1, completed: 0, goalReached: 0, byNode: { tagit: { entered: 1, failed: 0 }, wait: { entered: 1, failed: 0 } } });
  });
});
