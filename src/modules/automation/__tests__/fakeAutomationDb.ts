// BF_SERVER_v786_WORKFLOW_GRAPH - in-memory stand-in for the tables the workflow engine touches.
// Answers by SQL content, like the other DB-mocking tests. Not a test file itself.
import { vi } from "vitest";
import type { EngineDeps } from "../automationContext.js";

export type FakeContact = { id: string; silo: string; name?: string; first_name?: string; last_name?: string; phone?: string | null; email?: string | null; tags: string[]; owner_id?: string | null; lead_status?: string | null; company_name?: string | null };

export function fakeDb(opts: { contacts?: FakeContact[]; rules?: any[]; now?: Date } = {}) {
  const state = {
    clock: opts.now ?? new Date("2026-09-28T18:00:00Z"), // 12:00 in Alberta
    contacts: new Map((opts.contacts ?? []).map((c) => [c.id, { ...c }])),
    rules: [...(opts.rules ?? [])],
    enrollments: [] as any[],
    stepLog: [] as Array<{ enrollment: string; node: string; type: string; outcome: string; detail: string | null }>,
    timeline: [] as Array<{ contact_id: string; event_type: string; payload: any; created_at: string }>,
    inbound: [] as Array<{ contact_id: string; created_at: string }>,
    tasks: [] as any[],
    notifications: [] as any[],
    listMembers: [] as Array<{ list_id: string; contact_id: string }>,
    sql: [] as string[],
  };
  const row = (e: any) => ({ ...e, graph: JSON.parse(JSON.stringify(e.graph)), path: [...e.path], context: { ...e.context } });
  const query = vi.fn(async (sql: string, p: any[] = []) => {
    state.sql.push(sql);
    if (sql.includes("FROM contacts c LEFT JOIN users u")) {
      const c = state.contacts.get(String(p[0]));
      return { rows: c ? [{ ...c, owner_first: "Andrew", owner_last: "M" }] : [] };
    }
    if (sql.includes("FROM applications a WHERE a.id::text")) return { rows: [] };
    if (sql.includes("trigger_type = $2 AND graph IS NULL")) return { rows: [] };
    if (sql.includes("graph->'triggers' @> $2::jsonb")) {
      const type = JSON.parse(p[1])[0].type;
      return { rows: state.rules.filter((r) => r.enabled !== false && r.silo === p[0] && r.graph.triggers.some((t: any) => t.type === type)) };
    }
    if (sql.includes("FROM automation_rules WHERE id::text = $1 AND graph IS NOT NULL")) return { rows: state.rules.filter((r) => r.id === p[0]) };
    if (sql.includes("SELECT 1 FROM automation_enrollments")) {
      const hits = state.enrollments.filter((e) => e.rule_id === p[0] && (e.contact_id === p[1] || (p[2] && e.application_id === p[2])) && (!sql.includes("status = 'active'") || e.status === "active"));
      return { rows: hits.length ? [{ x: 1 }] : [] };
    }
    if (sql.startsWith("INSERT INTO automation_enrollments")) {
      const e = { id: `e-${state.enrollments.length + 1}`, rule_id: p[0], silo: p[1], contact_id: p[2], application_id: p[3], context: JSON.parse(p[4]), test_mode: p[5], schema_version: 2,
        graph: JSON.parse(p[6]), settings: JSON.parse(p[7]), goal: p[8] ? JSON.parse(p[8]) : null, current_node_id: p[9], path: [] as any[], status: "active", attempts: 0,
        next_run_at: state.clock.getTime(), wait_event: null as string | null, wait_timeout_at: null as string | null, goal_reached_at: null as string | null, steps_today: 0, steps_day: null, created_at: state.clock.toISOString(), last_error: null };
      state.enrollments.push(e);
      return { rows: [{ id: e.id }] };
    }
    if (sql.startsWith("UPDATE automation_enrollments SET locked_until")) {
      const e = state.enrollments.find((x) => x.id === p[0] && x.status === "active" && x.next_run_at <= state.clock.getTime());
      return { rows: e ? [row(e)] : [] };
    }
    if (sql.includes("FROM automation_enrollments") && sql.includes("wait_event = $1")) {
      return { rows: state.enrollments.filter((e) => e.status === "active" && e.wait_event === p[0] && e.contact_id === p[1]).map(row) };
    }
    if (sql.includes("FROM automation_enrollments") && sql.includes("goal IS NOT NULL")) {
      return { rows: state.enrollments.filter((e) => e.status === "active" && e.goal && e.contact_id === p[0]).map(row) };
    }
    if (sql.startsWith("UPDATE automation_enrollments SET current_node_id = $2, wait_event = NULL")) {
      const e = state.enrollments.find((x) => x.id === p[0] && x.wait_event);
      if (e) Object.assign(e, { current_node_id: p[1], wait_event: null, wait_timeout_at: null, next_run_at: state.clock.getTime(), path: JSON.parse(p[2]) });
      return { rows: [], rowCount: e ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE automation_enrollments SET status = 'completed', goal_reached_at")) {
      const e = state.enrollments.find((x) => x.id === p[0] && x.status === "active");
      if (e) Object.assign(e, { status: "completed", goal_reached_at: state.clock.toISOString(), wait_event: null, path: JSON.parse(p[1]) });
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE automation_enrollments SET current_node_id = $2, path")) {
      const e = state.enrollments.find((x) => x.id === p[0]);
      if (!e) return { rows: [] };
      Object.assign(e, { current_node_id: p[1], path: JSON.parse(p[2]), context: JSON.parse(p[3]), steps_today: p[4], steps_day: p[5] });
      if (sql.includes("status = 'completed'")) Object.assign(e, { status: "completed", wait_event: null });
      if (sql.includes("status = 'failed'")) Object.assign(e, { status: "failed", last_error: p[6] ?? e.last_error, wait_event: null });
      if (sql.includes("wait_event = $7")) Object.assign(e, { wait_event: p[6], wait_timeout_at: p[7], next_run_at: p[7] ? new Date(p[7]).getTime() : Infinity });
      else if (sql.includes("wait_event = NULL, wait_timeout_at = NULL")) Object.assign(e, { wait_event: null, wait_timeout_at: null });
      else if (sql.includes("next_run_at = $7")) e.next_run_at = new Date(p[6]).getTime();
      else if (sql.includes("next_run_at = now() + interval '15 minutes'")) Object.assign(e, { attempts: p[6], last_error: p[7], next_run_at: state.clock.getTime() + 15 * 60_000 });
      else if (sql.includes("attempts = $7")) e.attempts = p[6];
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO automation_step_log")) {
      state.stepLog.push({ enrollment: p[0], node: p[6], type: p[3], outcome: p[4], detail: p[5] });
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO crm_timeline_events")) {
      const payload = JSON.parse(sql.includes("'automation'") ? p[2] : p[1]);
      state.timeline.push({ contact_id: p[0], event_type: sql.includes("'automation'") ? "automation" : "other", payload, created_at: state.clock.toISOString() });
      return { rows: [] };
    }
    if (sql.includes("FROM crm_timeline_events WHERE contact_id::text = $1 AND event_type = ANY")) {
      return { rows: state.timeline.filter((t) => t.contact_id === p[0] && p[1].includes(t.event_type) && t.created_at >= p[2]).slice(0, 1).map(() => ({ x: 1 })) };
    }
    if (sql.includes("FROM communications_messages WHERE contact_id::text = $1 AND direction = 'inbound'")) {
      return { rows: state.inbound.filter((m) => m.contact_id === p[0] && m.created_at >= p[1]).slice(0, 1).map(() => ({ x: 1 })) };
    }
    if (sql.startsWith("INSERT INTO tasks")) { state.tasks.push({ title: p[1], type: p[3], priority: p[4], hours: p[5], assignee: p[6] }); return { rows: [{ id: `t-${state.tasks.length}` }] }; }
    if (sql.startsWith("INSERT INTO notifications")) { state.notifications.push({ user: p[0], body: p[2] }); return { rows: [{ id: "n" }] }; }
    if (sql.startsWith("UPDATE contacts SET tags")) {
      const c = state.contacts.get(String(p[0]));
      if (c) c.tags = sql.includes("array_remove") ? c.tags.filter((t) => t !== p[1]) : [...new Set([...c.tags, p[1]])];
      return { rows: [] };
    }
    if (sql.includes("SELECT c.phone FROM contacts c")) {
      const c = state.contacts.get(String(p[0]));
      return { rows: c?.phone ? [{ phone: c.phone }] : [] };
    }
    return { rows: [] };
  });
  const deps: EngineDeps = {
    query: query as any,
    now: () => state.clock,
    sendSms: vi.fn(async () => undefined),
    notifyClient: vi.fn(async () => "app" as const),
    sendEmail: vi.fn(async () => ({ ok: true })),
    sendStaffEmail: vi.fn(async () => ({ ok: true })),
  };
  const advance = (ms: number) => { state.clock = new Date(state.clock.getTime() + ms); };
  return { state, deps, query, advance };
}

export const contact = (over: Partial<FakeContact> = {}): FakeContact => ({ id: "c-1", silo: "BF", name: "Pat Lee", first_name: "Pat", last_name: "Lee", phone: "+17805551212", email: "pat@example.com", tags: [], owner_id: "u-1", lead_status: null, company_name: null, ...over });

export const rule = (graph: any, over: any = {}) => ({ id: "r-1", name: "Test workflow", silo: "BF", enabled: true, graph, settings: { reenroll: "always", quietHours: { enabled: false, start: "09:00", end: "20:00", tz: "America/Edmonton" }, unenrollOnGoal: true, testMode: false }, goal: null, ...over });
