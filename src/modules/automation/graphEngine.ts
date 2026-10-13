// BF_SERVER_v786_WORKFLOW_GRAPH - workflow engine v2. A rule with a graph enrolls a contact when ANY
// of its triggers fires and that trigger's filters pass. The enrollment keeps its own copy of the
// graph, so editing a workflow only affects new enrollments. The runner walks from startNodeId:
// actions run, delays park the enrollment (next_run_at or wait_event), branches pick a path, goto
// jumps. Every visited node is recorded in enrollments.path, automation_step_log and the contact
// timeline. The goal is checked before every step and on every event for the contact.
import { buildContext, type AutomationEvent, type EngineDeps, type Query } from "./automationContext.js";
import { runCheck } from "./automationSteps.js";
import { runGraphAction } from "./graphActions.js";
import {
  conditionsPass, convertV1Rule, durationMs, fieldsOf, nextTimeOfDay, normalizeSettings, quietHoursRelease, effectiveTz,
  renderTokens, SEND_ACTIONS, MAX_STEPS_PER_DAY,
  type Graph, type GraphNode, type Goal, type Settings, type Trigger,
} from "./graph.js";

const ENROLL_COLS = `id::text AS id, rule_id::text AS rule_id, silo, contact_id::text AS contact_id, application_id, context, test_mode, created_at,
  attempts, schema_version, graph, settings, goal, current_node_id, path, wait_event, wait_timeout_at, steps_today, steps_day`;

const nowIso = (d: Date) => d.toISOString();

// BF_SERVER_v792_WORKFLOW_TEST_RUN - a test enrollment walks the whole workflow in one run: delays
// are logged as "dry_run" and skipped, goals and quiet hours never pause it, and it is capped.
export const MAX_TEST_RUN_STEPS = 200;
const plural = (n: number, unit: string) => `${n} ${n === 1 ? unit.replace(/s$/, "") : unit}`;
function testWaitDetail(node: any, now: Date): string {
  const p = node.params ?? {};
  if (node.mode === "until_event") {
    const amount = Number(p.timeoutAmount) || 0;
    const timeout = amount > 0 ? plural(amount, String(p.timeoutUnit ?? "hours")) : "no time limit";
    return `would wait for ${p.event} (up to ${timeout}); test continues as if it did not happen`;
  }
  if (node.mode === "until_time") {
    const tz = effectiveTz(p.tz);
    const at = nextTimeOfDay(now, p.time, p.weekdays, tz);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at).map((x) => [x.type, x.value]));
    return `would wait until ${parts.weekday} ${String(Number(parts.hour) % 24).padStart(2, "0")}:${parts.minute}`;
  }
  return `would wait ${plural(Math.max(0, Number(p.amount) || 0), String(p.unit ?? "hours"))}`;
}
const asObj = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

// ---- facts ------------------------------------------------------------------------
/** Engagement since enrollment (email.opened, ...) and v1 check results, only for the fields asked for. */
export async function computedFacts(q: Query, e: any, fields: string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const since = e.created_at ?? new Date(0).toISOString();
  const cid = e.contact_id;
  const timeline = async (types: string[]) => {
    if (!cid) return false;
    const r = await q(`SELECT 1 FROM crm_timeline_events WHERE contact_id::text = $1 AND event_type = ANY($2::text[]) AND created_at >= $3 LIMIT 1`, [cid, types, since]);
    return r.rows.length > 0;
  };
  for (const f of new Set(fields)) {
    if (f === "email.opened") out[f] = await timeline(["email_open"]);
    else if (f === "email.clicked") out[f] = await timeline(["email_click"]);
    else if (f === "link.clicked") out[f] = await timeline(["sms_link_clicked", "email_click"]);
    else if (f === "sms.replied") {
      out[f] = cid ? (await q(`SELECT 1 FROM communications_messages WHERE contact_id::text = $1 AND direction = 'inbound' AND COALESCE(type, 'sms') IN ('sms', 'mms') AND created_at >= $2 LIMIT 1`, [cid, since])).rows.length > 0 : false;
    } else if (f === "booking.made") {
      out[f] = cid ? (await q(`SELECT 1 FROM client_bookings WHERE contact_id::text = $1 AND created_at >= $2 LIMIT 1`, [cid, since])).rows.length > 0 : false;
    } else if (f.startsWith("check.")) {
      out[f] = await runCheck(q, e, { type: "check", check: f.slice(6) });
    }
  }
  return out;
}

async function factsFor(q: Query, e: any, conds: unknown): Promise<Record<string, unknown>> {
  const wanted = fieldsOf(conds).filter((f) => f.includes("."));
  return wanted.length ? { ...(e.context ?? {}), ...(await computedFacts(q, e, wanted)) } : (e.context ?? {});
}

export async function goalMet(q: Query, e: any): Promise<boolean> {
  const goal = asObj(e.goal) as Goal;
  if (!goal || !Array.isArray(goal.conditions) || !goal.conditions.length) return false;
  return conditionsPass(goal.conditions, goal.logic, await factsFor(q, e, goal.conditions));
}

// ---- logging ------------------------------------------------------------------------
async function logNode(q: Query, e: any, index: number, node: { id: string; kind: string; action?: string }, outcome: string, detail: string | null) {
  const stepType = node.kind === "action" ? String(node.action) : node.kind;
  await q(`INSERT INTO automation_step_log (enrollment_id, rule_id, step_index, step_type, outcome, detail, node_id) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
    [e.id, e.rule_id, index, stepType, outcome, detail ? detail.slice(0, 500) : null, node.id]);
  if (e.contact_id) {
    await q(`INSERT INTO crm_timeline_events (contact_id, application_id, event_type, payload) VALUES ($1::uuid, $2, 'automation', $3::jsonb)`,
      [e.contact_id, e.application_id ?? null, JSON.stringify({ rule_id: e.rule_id, rule_name: e.context?.workflow_name ?? null, node_id: node.id, step: stepType, outcome, detail })])
      .catch((err: any) => console.warn("[automation] timeline write failed", { message: err?.message }));
  }
}

// ---- enrollment ------------------------------------------------------------------------
export function triggerMatches(graph: Graph, type: string, ctx: Record<string, unknown>): Trigger | null {
  for (const t of Array.isArray(graph?.triggers) ? graph.triggers : []) {
    if (t?.type === type && conditionsPass(t.filters, t.filterLogic, ctx)) return t;
  }
  return null;
}

type RuleRow = { id: string; name?: string; silo: string; graph: any; settings: any; goal: any };

export async function enrollGraph(deps: EngineDeps, rule: RuleRow, ctx: Record<string, unknown>, opts: { ignoreReenroll?: boolean } = {}): Promise<string | null> {
  const q = deps.query;
  const graph = asObj(rule.graph) as Graph;
  const settings: Settings = normalizeSettings(asObj(rule.settings));
  const contactId = (ctx.contact_id as string | null) ?? null;
  const appId = (ctx.application_id as string | null) ?? null;
  if (!contactId && !appId) return null;
  if (!graph?.startNodeId) return null;
  if (!opts.ignoreReenroll && settings.reenroll !== "always") {
    const prior = await q(
      `SELECT 1 FROM automation_enrollments
        WHERE rule_id = $1::uuid AND (($2::text IS NOT NULL AND contact_id::text = $2) OR ($3::text IS NOT NULL AND application_id = $3))
          ${settings.reenroll === "after_complete" ? "AND status = 'active'" : ""} LIMIT 1`, [rule.id, contactId, appId]);
    if (prior.rows.length) return null;
  }
  const context = { ...ctx, workflow_name: rule.name ?? null };
  const ins = await q(
    `INSERT INTO automation_enrollments (rule_id, rule_version, silo, contact_id, application_id, context, steps, test_mode, schema_version, graph, settings, goal, current_node_id, path)
     VALUES ($1::uuid, 2, $2, $3::uuid, $4, $5::jsonb, '[]'::jsonb, $6, 2, $7::jsonb, $8::jsonb, $9::jsonb, $10, '[]'::jsonb) RETURNING id::text AS id`,
    [rule.id, String(ctx.silo ?? rule.silo ?? "BF"), contactId, appId, JSON.stringify(context), settings.testMode, JSON.stringify(graph), JSON.stringify(settings),
     rule.goal ? JSON.stringify(asObj(rule.goal)) : null, graph.startNodeId]);
  return ins.rows[0]?.id ?? null;
}

const RULE_COLS = `id::text AS id, name, silo, graph, settings, goal`;

/** Enrolls into one named workflow (manual enroll and the enroll_workflow action). Same silo only. */
export async function enrollContactInRule(deps: EngineDeps, ruleId: string, ev: { silo?: string | null; contactId?: string | null; applicationId?: string | null; data?: Record<string, unknown> }, opts: { ignoreReenroll?: boolean } = {}): Promise<string | null> {
  const q = deps.query;
  const r = await q(`SELECT ${RULE_COLS} FROM automation_rules WHERE id::text = $1 AND graph IS NOT NULL LIMIT 1`, [ruleId]);
  const rule = r.rows[0];
  if (!rule) return null;
  const ctx = await buildContext(q, { trigger: "manual", silo: ev.silo ?? rule.silo, contactId: ev.contactId ?? null, applicationId: ev.applicationId ?? null, data: ev.data });
  if (String(ctx.silo) !== String(rule.silo ?? "BF").toUpperCase()) return null;
  return enrollGraph(deps, rule, ctx, opts);
}

/** Event bus, v2 half: enroll matching workflows, wake enrollments waiting on this event, check goals. Returns enrollment ids to run now. */
export async function emitGraph(deps: EngineDeps, ev: AutomationEvent): Promise<string[]> {
  const q = deps.query;
  const ctx = await buildContext(q, ev);
  const silo = String(ctx.silo);
  const ids: string[] = [];
  const rules = await q(
    `SELECT ${RULE_COLS} FROM automation_rules
      WHERE enabled = true AND graph IS NOT NULL AND silo = $1 AND graph->'triggers' @> $2::jsonb`,
    [silo, JSON.stringify([{ type: ev.trigger }])]);
  for (const rule of rules.rows) {
    const graph = asObj(rule.graph) as Graph;
    if (!triggerMatches(graph, ev.trigger, ctx)) continue;
    const id = await enrollGraph(deps, rule, ctx);
    if (id) ids.push(id);
  }
  const contactId = (ctx.contact_id as string | null) ?? null;
  if (contactId) {
    // Wake enrollments parked on "until this event happens".
    const waiting = await q(
      `SELECT ${ENROLL_COLS} FROM automation_enrollments
        WHERE status = 'active' AND schema_version = 2 AND wait_event = $1 AND contact_id::text = $2 AND silo = $3`,
      [ev.trigger, contactId, silo]);
    for (const e of waiting.rows) {
      const graph = asObj(e.graph) as Graph;
      const node = graph?.nodes?.[e.current_node_id] as GraphNode | undefined;
      const next = node && node.kind === "delay" ? node.next : null;
      const path = [...(Array.isArray(asObj(e.path)) ? asObj(e.path) : []), { nodeId: e.current_node_id, kind: "delay", at: nowIso(deps.now()), result: `event ${ev.trigger} happened` }];
      await q(`UPDATE automation_enrollments SET current_node_id = $2, wait_event = NULL, wait_timeout_at = NULL, next_run_at = now(), path = $3::jsonb, updated_at = now() WHERE id = $1::uuid AND wait_event IS NOT NULL`,
        [e.id, next, JSON.stringify(path)]);
      if (node) await logNode(q, e, path.length - 1, node, "resumed", `event ${ev.trigger} happened`);
      ids.push(e.id);
    }
    // Goals are checked on every event for the contact.
    const active = await q(
      `SELECT ${ENROLL_COLS} FROM automation_enrollments
        WHERE status = 'active' AND schema_version = 2 AND goal IS NOT NULL AND contact_id::text = $1`, [contactId]);
    for (const e of active.rows) {
      const settings = normalizeSettings(asObj(e.settings));
      if (!settings.unenrollOnGoal) continue;
      e.context = { ...(asObj(e.context) ?? {}), ...ctx };
      if (await goalMet(q, e)) await finishGoal(q, e, deps.now());
    }
  }
  return [...new Set(ids)];
}

async function finishGoal(q: Query, e: any, now: Date) {
  const path = [...(Array.isArray(asObj(e.path)) ? asObj(e.path) : []), { nodeId: null, kind: "goal", at: nowIso(now), result: "goal reached" }];
  await q(`UPDATE automation_enrollments SET status = 'completed', goal_reached_at = now(), completed_at = now(), locked_until = NULL, wait_event = NULL, path = $2::jsonb WHERE id = $1::uuid AND status = 'active'`,
    [e.id, JSON.stringify(path)]);
  await logNode(q, e, path.length - 1, { id: "goal", kind: "goal" }, "goal_reached", "goal reached - unenrolled");
}

// ---- runner ------------------------------------------------------------------------
/** Runs a claimed v2 enrollment until it waits, fails or ends. */
export async function runGraphClaimed(deps: EngineDeps, e: any): Promise<string> {
  const q = deps.query;
  const graph = asObj(e.graph) as Graph;
  const settings = normalizeSettings(asObj(e.settings));
  e.goal = asObj(e.goal);
  e.context = asObj(e.context) ?? {};
  const path: any[] = Array.isArray(asObj(e.path)) ? [...asObj(e.path)] : [];
  const today = deps.now().toISOString().slice(0, 10);
  let stepsToday = String(e.steps_day ?? "").slice(0, 10) === today ? Number(e.steps_today) || 0 : 0;
  let current: string | null = e.current_node_id ?? null;
  const testRun = !!(settings.testMode || e.test_mode);
  let testSteps = 0;
  // Fresh contact / application facts for every run; the event data from enrollment is kept.
  const fresh = await buildContext(q, { trigger: "run", silo: e.silo, contactId: e.contact_id, applicationId: e.application_id });
  const { from_stage: _f, to_stage: _t, source: _s, ...current_facts } = fresh;
  e.context = { ...e.context, ...current_facts };

  const record = (node: { id: string; kind: string }, result: string) => path.push({ nodeId: node.id, kind: node.kind, at: nowIso(deps.now()), result: result.slice(0, 300) });
  const save = (extra = "", params: unknown[] = []) => q(
    `UPDATE automation_enrollments SET current_node_id = $2, path = $3::jsonb, context = $4::jsonb, steps_today = $5, steps_day = $6::date, updated_at = now()${extra} WHERE id = $1::uuid`,
    [e.id, current, JSON.stringify(path), JSON.stringify(e.context), stepsToday, today, ...params]);
  const end = async (status: "completed" | "failed", error: string | null) => {
    await save(`, status = '${status}', locked_until = NULL, completed_at = now(), wait_event = NULL, last_error = COALESCE($7, last_error)`, [error]);
    if (status === "failed") console.error("[automation] enrollment failed", { enrollmentId: e.id, node: current, error });
    return status;
  };

  for (;;) {
    // Test runs never stop early for the goal; they walk the whole workflow.
    if (!testRun && e.goal && settings.unenrollOnGoal && await goalMet(q, e)) {
      await save();
      await finishGoal(q, { ...e, path }, deps.now());
      return "goal_reached";
    }
    if (!current) return end("completed", null);
    const node = graph?.nodes?.[current] as GraphNode | undefined;
    if (!node) return end("failed", `step ${current} does not exist`);
    if (testRun) {
      testSteps += 1;
      if (testSteps > MAX_TEST_RUN_STEPS) {
        await logNode(q, e, path.length, node, "stopped", "stopped: too many steps");
        await save(`, status = 'stopped', locked_until = NULL, completed_at = now(), wait_event = NULL, last_error = 'too_many_steps'`);
        return "stopped";
      }
    }
    stepsToday += 1;
    if (!testRun && stepsToday > MAX_STEPS_PER_DAY) {
      await logNode(q, e, path.length, node, "failed", `loop guard: more than ${MAX_STEPS_PER_DAY} steps today`);
      return end("failed", "loop_guard");
    }
    const idx = path.length;
    switch (node.kind) {
      case "goto": {
        record(node, `go to ${node.target}`);
        await logNode(q, e, idx, node, "done", `go to ${node.target}`);
        current = node.target;
        break;
      }
      case "branch": {
        let chosen: { id: string; label?: string; next: string | null } | null = null;
        for (const b of node.branches ?? []) {
          const facts = await factsFor(q, e, b.conditions);
          if (conditionsPass(b.conditions, b.logic, facts) && Array.isArray(b.conditions) && b.conditions.length) { chosen = b; break; }
        }
        const result = chosen ? `path ${chosen.label || chosen.id}` : "no path matched";
        record(node, result);
        await logNode(q, e, idx, node, "done", result);
        current = chosen ? chosen.next : node.noneNext;
        break;
      }
      case "value_branch": {
        const actual = (await factsFor(q, e, [{ field: node.field, op: "eq" }]))[node.field];
        const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
        const hit = (node.cases ?? []).find((c) => Array.isArray(actual) ? actual.map(norm).includes(norm(c.value)) : norm(actual) === norm(c.value)) ?? null;
        const result = hit ? `value ${hit.label || String(hit.value)}` : "no value matched";
        record(node, result);
        await logNode(q, e, idx, node, "done", result);
        current = hit ? hit.next : node.noneNext;
        break;
      }
      case "delay": {
        const now = deps.now();
        if (testRun) {
          const detail = testWaitDetail(node, now);
          record(node, `test mode - ${detail}`);
          await logNode(q, e, idx, node, "dry_run", detail);
          current = node.mode === "until_event" ? (node.timeoutNext ?? node.next) : node.next;
          break;
        }
        if (node.mode === "until_event") {
          if (e.wait_event) {
            // Claimed while still waiting: the timeout passed.
            record(node, "timed out");
            await logNode(q, e, idx, node, "timeout", `no ${node.params.event} before the timeout`);
            e.wait_event = null;
            current = node.timeoutNext;
            await save(`, wait_event = NULL, wait_timeout_at = NULL`);
            break;
          }
          const ms = durationMs(node.params.timeoutAmount, node.params.timeoutUnit);
          const at = ms > 0 ? new Date(now.getTime() + ms) : null;
          record(node, `waiting for ${node.params.event}${at ? ` until ${nowIso(at)}` : ""}`);
          await logNode(q, e, idx, node, "waiting", `waiting for ${node.params.event}${at ? ` until ${nowIso(at)}` : ""}`);
          await save(`, wait_event = $7, wait_timeout_at = $8, next_run_at = COALESCE($8::timestamptz, 'infinity'::timestamptz), locked_until = NULL, attempts = 0`, [node.params.event, at ? nowIso(at) : null]);
          return "waiting";
        }
        const at = node.mode === "until_time"
          ? nextTimeOfDay(now, node.params.time, node.params.weekdays, effectiveTz(node.params.tz))
          : new Date(now.getTime() + durationMs(node.params.amount, node.params.unit));
        record(node, `wait until ${nowIso(at)}`);
        await logNode(q, e, idx, node, "waiting", `until ${nowIso(at)}`);
        current = node.next;
        await save(`, next_run_at = $7, locked_until = NULL, attempts = 0`, [nowIso(at)]);
        return "waiting";
      }
      case "action": {
        const label = renderTokens(node.params?.title || node.params?.body || node.params?.message || node.action, e.context).slice(0, 200);
        if (testRun) {
          record(node, `test mode - would run: ${label}`);
          await logNode(q, e, idx, node, "dry_run", `would run: ${label}`);
          current = node.next;
          break;
        }
        if (SEND_ACTIONS.has(node.action)) {
          const later = quietHoursRelease(deps.now(), settings.quietHours);
          if (later) {
            await logNode(q, e, idx, node, "waiting", `quiet hours - sending at ${nowIso(later)}`);
            await save(`, next_run_at = $7, locked_until = NULL`, [nowIso(later)]);
            return "quiet_hours";
          }
        }
        try {
          const detail = await runGraphAction(deps, e, node);
          const outcome = detail.startsWith("skip:") ? "skipped" : "done";
          record(node, detail);
          await logNode(q, e, idx, node, outcome, detail);
          current = node.next;
          e.attempts = 0;
          await save(`, attempts = 0`);
        } catch (err: any) {
          const attempts = Number(e.attempts ?? 0) + 1;
          const message = String(err?.message ?? err).slice(0, 300);
          await logNode(q, e, idx, node, "failed", message);
          if (attempts >= 3) {
            record(node, `failed: ${message}`);
            await save(`, attempts = $7`, [attempts]);
            return end("failed", message);
          }
          await save(`, attempts = $7, last_error = $8, next_run_at = now() + interval '15 minutes', locked_until = NULL`, [attempts, message]);
          return "retry";
        }
        break;
      }
      default:
        return end("failed", `unknown step kind ${(node as any).kind}`);
    }
  }
}

// ---- daily triggers (worker) ------------------------------------------------------------
function localDate(now: Date, tz: string, offsetDays = 0): string {
  const d = new Date(now.getTime() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: effectiveTz(tz), year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function localMinutes(now: Date, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: effectiveTz(tz), hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}
const tparam = (t: Trigger, k: string) => (t.params && t.params[k] !== undefined ? t.params[k] : (t as any)[k]);

/** date.relative and no_reply: evaluated by the worker, at most once per workflow, contact and day. */
export async function runDailyTriggers(deps: EngineDeps): Promise<number> {
  const q = deps.query;
  const now = deps.now();
  let enrolled = 0;
  const rules = await q(
    `SELECT ${RULE_COLS} FROM automation_rules
      WHERE enabled = true AND graph IS NOT NULL
        AND (graph->'triggers' @> '[{"type":"date.relative"}]'::jsonb OR graph->'triggers' @> '[{"type":"no_reply"}]'::jsonb)`);
  for (const rule of rules.rows) {
    const graph = asObj(rule.graph) as Graph;
    const settings = normalizeSettings(asObj(rule.settings));
    const tz = settings.quietHours.tz;
    for (const t of graph.triggers ?? []) {
      let ids: string[] = [];
      if (t.type === "date.relative") {
        const time = String(tparam(t, "time") ?? "09:00");
        const [h, m] = time.split(":").map(Number);
        if (localMinutes(now, tz) < (h || 0) * 60 + (m || 0)) continue;
        const target = localDate(now, tz, -Number(tparam(t, "offsetDays") ?? 0));
        const field = String(tparam(t, "field") ?? "created_at");
        const tzName = effectiveTz(tz);
        const where = field === "dob"
          ? `to_char(c.dob, 'MM-DD') = to_char($2::date, 'MM-DD')`
          : field === "booking_starts_at"
            ? `EXISTS (SELECT 1 FROM client_bookings b WHERE b.contact_id = c.id AND b.status = 'booked' AND (b.starts_at AT TIME ZONE '${tzName.replace(/'/g, "")}')::date = $2::date)`
            : field === "updated_at"
              ? `(c.updated_at AT TIME ZONE '${tzName.replace(/'/g, "")}')::date = $2::date`
              : `(c.created_at AT TIME ZONE '${tzName.replace(/'/g, "")}')::date = $2::date`;
        const r = await q(`SELECT c.id::text AS id FROM contacts c WHERE c.silo = $1 AND c.merged_into_id IS NULL AND ${where} LIMIT 500`, [rule.silo, target]);
        ids = r.rows.map((x: any) => x.id);
      } else if (t.type === "no_reply") {
        const days = Math.max(1, Number(tparam(t, "days") ?? 3) || 3);
        const r = await q(
          `SELECT m.contact_id::text AS id
             FROM communications_messages m JOIN contacts c ON c.id::text = m.contact_id::text
            WHERE c.silo = $1 AND m.direction = 'outbound'
            GROUP BY m.contact_id
           HAVING (max(m.created_at))::date = (now() - ($2 || ' days')::interval)::date
              AND NOT EXISTS (SELECT 1 FROM communications_messages i WHERE i.contact_id::text = m.contact_id::text AND i.direction = 'inbound' AND i.created_at > max(m.created_at))
            LIMIT 500`, [rule.silo, String(days)]);
        ids = r.rows.map((x: any) => x.id);
      } else continue;
      for (const contactId of ids) {
        const fire = await q(`INSERT INTO automation_daily_fires (rule_id, contact_id, fired_on) VALUES ($1::uuid, $2::uuid, $3::date) ON CONFLICT DO NOTHING RETURNING rule_id`, [rule.id, contactId, localDate(now, tz)]);
        if (!fire.rows.length) continue;
        const ctx = await buildContext(q, { trigger: t.type, silo: rule.silo, contactId });
        if (!conditionsPass(t.filters, t.filterLogic, ctx)) continue;
        if (await enrollGraph(deps, rule, ctx)) enrolled += 1;
      }
    }
  }
  return enrolled;
}

// ---- v1 -> v2 conversion on startup --------------------------------------------------------
/** Idempotent: converts every rule whose graph is still NULL. The v1 steps column is left untouched. */
export async function convertV1Rules(q: Query): Promise<number> {
  const r = await q(`SELECT id::text AS id, trigger_type, conditions, steps, actions, reenroll, test_mode FROM automation_rules WHERE graph IS NULL`);
  let n = 0;
  for (const rule of r.rows) {
    const { graph, settings, goal } = convertV1Rule(rule);
    const u = await q(`UPDATE automation_rules SET graph = $2::jsonb, settings = $3::jsonb, goal = $4::jsonb, schema_version = 2, updated_at = now() WHERE id = $1::uuid AND graph IS NULL`,
      [rule.id, JSON.stringify(graph), JSON.stringify(settings), goal ? JSON.stringify(goal) : null]);
    n += Number(u.rowCount ?? 0);
  }
  if (n) console.log("[automation] converted v1 rules to workflow graphs", { converted: n });
  return n;
}
