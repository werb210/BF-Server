// BF_SERVER_v786_WORKFLOW_GRAPH - workflow graph format (schema_version 2), shared with BF-portal v786.
// Pure: no SQL. Types, condition evaluation, validation, v1 -> v2 conversion and the time helpers
// the engine uses for delays and quiet hours.
import { ALBERTA_TZ } from "../../lib/albertaTime.js";

export type Condition = { field: string; op: string; value?: unknown };
export type Trigger = { type: string; filters?: Condition[]; filterLogic?: "all" | "any"; params?: Record<string, unknown> } & Record<string, unknown>;
export type ActionNode = { id: string; kind: "action"; action: string; params?: Record<string, any>; next: string | null };
export type DelayNode =
  | { id: string; kind: "delay"; mode: "duration"; params: { amount: number; unit: "minutes" | "hours" | "days" }; next: string | null }
  | { id: string; kind: "delay"; mode: "until_time"; params: { time: string; weekdays: number[] | null; tz?: string }; next: string | null }
  | { id: string; kind: "delay"; mode: "until_event"; params: { event: string; timeoutAmount?: number; timeoutUnit?: string }; next: string | null; timeoutNext: string | null };
export type BranchNode = { id: string; kind: "branch"; branches: Array<{ id: string; label?: string; logic?: "all" | "any"; conditions: Condition[]; next: string | null }>; noneNext: string | null };
export type ValueBranchNode = { id: string; kind: "value_branch"; field: string; cases: Array<{ id: string; label?: string; value: unknown; next: string | null }>; noneNext: string | null };
export type GotoNode = { id: string; kind: "goto"; target: string };
export type GraphNode = ActionNode | DelayNode | BranchNode | ValueBranchNode | GotoNode;
export type Graph = { triggers: Trigger[]; startNodeId: string | null; nodes: Record<string, GraphNode> };
export type Settings = {
  reenroll: "never" | "after_complete" | "always";
  quietHours: { enabled: boolean; start: string; end: string; tz: string };
  unenrollOnGoal: boolean;
  testMode: boolean;
};
export type Goal = null | { logic: "all" | "any"; conditions: Condition[] };
export type Issue = { nodeId: string | null; message: string };

// The v786 graph format (shared with BF-portal) stores this zone name; effectiveTz() computes it as
// ALBERTA_TZ (UTC-6 all year), so nothing here assumes Edmonton clock changes.
export const DEFAULT_TZ = "America/Edmonton";
export const MAX_STEPS_PER_DAY = 200;
export const DEFAULT_SETTINGS: Settings = {
  reenroll: "never",
  quietHours: { enabled: true, start: "09:00", end: "20:00", tz: DEFAULT_TZ },
  unenrollOnGoal: true,
  testMode: false,
};

export function normalizeSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const q = (s.quietHours && typeof s.quietHours === "object" ? s.quietHours : {}) as Record<string, any>;
  return {
    reenroll: ["never", "after_complete", "always"].includes(s.reenroll) ? s.reenroll : "never",
    quietHours: {
      enabled: typeof q.enabled === "boolean" ? q.enabled : true,
      start: /^\d{2}:\d{2}$/.test(String(q.start)) ? String(q.start) : "09:00",
      end: /^\d{2}:\d{2}$/.test(String(q.end)) ? String(q.end) : "20:00",
      tz: typeof q.tz === "string" && q.tz ? q.tz : DEFAULT_TZ,
    },
    unenrollOnGoal: typeof s.unenrollOnGoal === "boolean" ? s.unenrollOnGoal : true,
    testMode: s.testMode === true,
  };
}

// ---- conditions ---------------------------------------------------------------
export const OPERATORS = ["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "contains", "not_contains", "is_set", "is_not_set", "changed_to"] as const;
export const ENGAGEMENT_FIELDS = ["email.opened", "email.clicked", "sms.replied", "link.clicked", "booking.made"] as const;
/** v1 "check" steps become branch conditions on these computed fields. */
export const CHECK_FIELDS = ["check.still_in_stage", "check.documents_still_rejected", "check.no_reply_since_start"] as const;

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : typeof v === "boolean" ? String(v) : v);
const isSet = (v: unknown) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);

export function evaluateCondition(c: Condition, ctx: Record<string, unknown>): boolean {
  if (!c || typeof c !== "object" || typeof c.field !== "string") return false;
  const actual = ctx[c.field];
  const list = Array.isArray(c.value) ? c.value.map(norm) : [norm(c.value)];
  switch (c.op) {
    case "eq": return Array.isArray(actual) ? actual.map(norm).includes(norm(c.value)) : norm(actual) === norm(c.value);
    case "neq": return Array.isArray(actual) ? !actual.map(norm).includes(norm(c.value)) : norm(actual) !== norm(c.value);
    case "in": return Array.isArray(actual) ? actual.map(norm).some((a) => list.includes(a)) : list.includes(norm(actual));
    case "not_in": return Array.isArray(actual) ? !actual.map(norm).some((a) => list.includes(a)) : !list.includes(norm(actual));
    case "gt": return isSet(actual) && Number(actual) > Number(c.value);
    case "gte": return isSet(actual) && Number(actual) >= Number(c.value);
    case "lt": return isSet(actual) && Number(actual) < Number(c.value);
    case "lte": return isSet(actual) && Number(actual) <= Number(c.value);
    case "contains": return Array.isArray(actual) ? actual.map(norm).includes(norm(c.value)) : String(actual ?? "").toLowerCase().includes(String(c.value ?? "").toLowerCase());
    case "not_contains": return !evaluateCondition({ ...c, op: "contains" }, ctx);
    case "is_set": return isSet(actual);
    case "is_not_set": return !isSet(actual);
    // contact.field_changed carries {field, from, to}; also stage changes (to_stage).
    case "changed_to": {
      if (norm(ctx.field) === norm(c.field)) return norm(ctx.to) === norm(c.value);
      if (c.field === "stage" || c.field === "pipeline_state") return norm(ctx.to_stage) === norm(c.value);
      return false;
    }
    default: return false;
  }
}

export function conditionsPass(conds: unknown, logic: unknown, ctx: Record<string, unknown>): boolean {
  if (!Array.isArray(conds) || conds.length === 0) return true;
  const results = conds.map((c) => evaluateCondition(c as Condition, ctx));
  return logic === "any" ? results.some(Boolean) : results.every(Boolean);
}

/** Every field a set of conditions reads, so the engine only computes the engagement facts it needs. */
export function fieldsOf(conds: unknown): string[] {
  return Array.isArray(conds) ? conds.map((c: any) => String(c?.field ?? "")).filter(Boolean) : [];
}

export function renderTokens(text: unknown, ctx: Record<string, unknown>): string {
  return String(text ?? "").replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, k: string) => {
    const v = ctx[k];
    return v === null || v === undefined ? "" : String(v);
  });
}

// ---- time ---------------------------------------------------------------------
// BF_SERVER_ALBERTA_TIME_v743 - "America/Edmonton" is stored (it is what staff pick) but computed as
// ALBERTA_TZ, since Alberta is UTC-6 all year and older tz data still falls back an hour.
export const effectiveTz = (tz: string | null | undefined) => (!tz || tz === "America/Edmonton" ? ALBERTA_TZ : tz);
function zoneParts(at: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: effectiveTz(tz), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" })
    .formatToParts(at).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, min: Number(p.minute), s: Number(p.second), dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday)) };
}
function offsetMin(at: Date, tz: string): number {
  const p = zoneParts(at, tz);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - at.getTime()) / 60_000);
}
/** The instant that is y-m-d h:min wall-clock time in tz. */
export function zonedTime(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, h, min));
  const first = new Date(guess.getTime() - offsetMin(guess, tz) * 60_000);
  return new Date(guess.getTime() - offsetMin(first, tz) * 60_000);
}
const hm = (s: string) => { const [h, m] = String(s).split(":").map(Number); return { h: h || 0, m: m || 0 }; };

export function durationMs(amount: unknown, unit: unknown): number {
  const n = Math.max(0, Number(amount ?? 0));
  const u = String(unit ?? "hours");
  return n * (u === "minutes" ? 60_000 : u === "days" ? 86_400_000 : 3_600_000);
}

/** Next instant at HH:MM in tz, strictly after now, on one of the weekdays (0 = Sunday; null = any day). */
export function nextTimeOfDay(now: Date, time: string, weekdays: number[] | null | undefined, tz = DEFAULT_TZ): Date {
  const { h, m } = hm(time);
  const days = Array.isArray(weekdays) && weekdays.length ? weekdays.map(Number) : null;
  for (let i = 0; i <= 8; i += 1) {
    const p = zoneParts(new Date(now.getTime() + i * 86_400_000), tz);
    const at = zonedTime(p.y, p.m, p.d, h, m, tz);
    if (at.getTime() <= now.getTime()) continue;
    if (days && !days.includes(zoneParts(at, tz).dow)) continue;
    return at;
  }
  return new Date(now.getTime() + 86_400_000);
}

/** null when now is inside the allowed window; otherwise the next start of the window. */
export function quietHoursRelease(now: Date, q: Settings["quietHours"] | null | undefined): Date | null {
  if (!q || !q.enabled) return null;
  const tz = q.tz || DEFAULT_TZ;
  const p = zoneParts(now, tz);
  const cur = p.h * 60 + p.min;
  const s = hm(q.start), e = hm(q.end);
  const start = s.h * 60 + s.m, end = e.h * 60 + e.m;
  const inside = start <= end ? cur >= start && cur < end : cur >= start || cur < end;
  if (inside) return null;
  return nextTimeOfDay(now, q.start, null, tz);
}

// ---- catalog shape (the portal builder reads it) ---------------------------------
export const TRIGGER_TYPES = [
  "contact.created", "contact.field_changed", "application.created", "application.stage_changed", "document.uploaded", "document.rejected",
  "booking.created", "meeting.completed", "message.inbound", "call.missed", "link.clicked", "email.opened", "email.clicked", "email.bounced",
  "email.unsubscribed", "date.relative", "no_reply", "manual",
] as const;
export const ACTION_TYPES = [
  "send_email", "send_sms", "notify_client", "notify_staff", "team_post", "rotate_owner", "assign_owner", "create_task", "add_note",
  "set_contact_field", "set_application_stage", "add_tag", "remove_tag", "add_to_list", "remove_from_list", "webhook", "enroll_workflow",
] as const;
export const SEND_ACTIONS = new Set(["send_email", "send_sms", "notify_client", "notify_staff"]);
export const CONTACT_FIELDS_SETTABLE = ["first_name", "last_name", "name", "email", "phone", "job_title", "company_name", "lead_status", "lifecycle_stage", "status", "role"];

// ---- validation ---------------------------------------------------------------
export type ValidateRefs = { templates?: { email: string[]; sms: string[] }; lists?: string[]; workflows?: string[]; users?: string[] };

function refIssue(issues: Issue[], nodes: Record<string, GraphNode>, nodeId: string, ref: unknown, label: string) {
  if (ref === null || ref === undefined) return;
  if (typeof ref !== "string" || !nodes[ref]) issues.push({ nodeId, message: `${label} points to a step that does not exist` });
}

export function validateGraph(graph: unknown, settings?: unknown, goal?: unknown, refs: ValidateRefs = {}): Issue[] {
  const issues: Issue[] = [];
  const g = graph as Graph;
  if (!g || typeof g !== "object") return [{ nodeId: null, message: "workflow has no graph" }];
  const nodes = g.nodes && typeof g.nodes === "object" ? g.nodes : {};
  if (!Array.isArray(g.triggers) || g.triggers.length === 0) issues.push({ nodeId: null, message: "add at least one trigger" });
  for (const [i, t] of (Array.isArray(g.triggers) ? g.triggers : []).entries()) {
    if (!t || !(TRIGGER_TYPES as readonly string[]).includes(String(t.type))) issues.push({ nodeId: `trigger:${i}`, message: `unknown trigger ${t?.type ?? ""}`.trim() });
    for (const f of Array.isArray(t?.filters) ? t.filters : []) {
      if (!f || !f.field || !(OPERATORS as readonly string[]).includes(String(f.op))) issues.push({ nodeId: `trigger:${i}`, message: "a trigger filter needs a field and a valid operator" });
    }
    if (t?.type === "date.relative") {
      const p = { ...(t.params ?? {}), ...t } as Record<string, unknown>;
      if (!p.field) issues.push({ nodeId: `trigger:${i}`, message: "date trigger needs a date field" });
    }
  }
  if (g.startNodeId !== null && g.startNodeId !== undefined && !nodes[g.startNodeId]) issues.push({ nodeId: null, message: "the first step does not exist" });
  if (!g.startNodeId) issues.push({ nodeId: null, message: "the workflow has no steps" });
  const templates = refs.templates;
  for (const [key, n] of Object.entries(nodes)) {
    const id = String((n as any)?.id ?? key);
    if (!n || typeof n !== "object") { issues.push({ nodeId: key, message: "invalid step" }); continue; }
    if ((n as any).id !== key) issues.push({ nodeId: key, message: "step id does not match its key" });
    switch (n.kind) {
      case "action": {
        const p = (n.params ?? {}) as Record<string, any>;
        if (!(ACTION_TYPES as readonly string[]).includes(n.action)) { issues.push({ nodeId: id, message: `unknown action ${n.action}` }); break; }
        if (n.action === "send_email") {
          if (!p.templateId) issues.push({ nodeId: id, message: "pick an email template" });
          else if (templates && !templates.email.includes(String(p.templateId))) issues.push({ nodeId: id, message: "the email template no longer exists" });
        }
        if (n.action === "send_sms") {
          if (!p.templateId && !String(p.body ?? "").trim()) issues.push({ nodeId: id, message: "a text needs a template or a message" });
          if (p.templateId && templates && !templates.sms.includes(String(p.templateId))) issues.push({ nodeId: id, message: "the text template no longer exists" });
        }
        if (n.action === "notify_client" && !String(p.body ?? "").trim()) issues.push({ nodeId: id, message: "the notice needs a message" });
        if (n.action === "notify_staff") {
          if (!["email", "sms", "in_app", "team"].includes(String(p.channel ?? "in_app"))) issues.push({ nodeId: id, message: "unknown staff channel" });
          if (!String(p.message ?? "").trim()) issues.push({ nodeId: id, message: "the staff notice needs a message" });
        }
        if (n.action === "team_post" && !String(p.channel ?? "").trim()) issues.push({ nodeId: id, message: "pick a Team channel" });
        // rotate_owner with no userIds rotates between all active staff (as v1 did).
        if (n.action === "rotate_owner" && p.userIds !== undefined && !Array.isArray(p.userIds)) issues.push({ nodeId: id, message: "pick the people to rotate between" });
        if (n.action === "assign_owner" && !p.userId) issues.push({ nodeId: id, message: "pick an owner" });
        if (n.action === "create_task" && !String(p.title ?? "").trim()) issues.push({ nodeId: id, message: "the task needs a title" });
        if (n.action === "add_note" && !String(p.body ?? "").trim()) issues.push({ nodeId: id, message: "the note needs text" });
        if (n.action === "set_contact_field" && !CONTACT_FIELDS_SETTABLE.includes(String(p.field))) issues.push({ nodeId: id, message: "pick a contact field that can be set" });
        if (n.action === "set_application_stage" && !String(p.stage ?? "").trim()) issues.push({ nodeId: id, message: "pick a stage" });
        if ((n.action === "add_tag" || n.action === "remove_tag") && !String(p.tag ?? "").trim()) issues.push({ nodeId: id, message: "enter a tag" });
        if (n.action === "add_to_list" || n.action === "remove_from_list") {
          if (!p.listId) issues.push({ nodeId: id, message: "pick a list" });
          else if (refs.lists && !refs.lists.includes(String(p.listId))) issues.push({ nodeId: id, message: "the list no longer exists" });
        }
        if (n.action === "webhook") {
          let ok = false;
          try { ok = new URL(String(p.url ?? "")).protocol === "https:"; } catch { ok = false; }
          if (!ok) issues.push({ nodeId: id, message: "webhook URL must start with https://" });
        }
        if (n.action === "enroll_workflow") {
          if (!p.workflowId) issues.push({ nodeId: id, message: "pick a workflow" });
          else if (refs.workflows && !refs.workflows.includes(String(p.workflowId))) issues.push({ nodeId: id, message: "that workflow no longer exists" });
        }
        refIssue(issues, nodes, id, n.next, "next");
        break;
      }
      case "delay": {
        const p = ((n as any).params ?? {}) as Record<string, any>;
        if (n.mode === "duration") {
          if (!(Number(p.amount) > 0) || !["minutes", "hours", "days"].includes(String(p.unit))) issues.push({ nodeId: id, message: "the delay needs an amount and a unit" });
        } else if (n.mode === "until_time") {
          if (!/^\d{2}:\d{2}$/.test(String(p.time ?? ""))) issues.push({ nodeId: id, message: "the delay needs a time (HH:MM)" });
          if (p.weekdays != null && (!Array.isArray(p.weekdays) || p.weekdays.some((d: unknown) => !(Number(d) >= 0 && Number(d) <= 6)))) issues.push({ nodeId: id, message: "weekdays must be 0-6" });
        } else if (n.mode === "until_event") {
          if (!(TRIGGER_TYPES as readonly string[]).includes(String(p.event))) issues.push({ nodeId: id, message: "pick the event to wait for" });
          if (p.timeoutAmount != null && !(Number(p.timeoutAmount) > 0)) issues.push({ nodeId: id, message: "the timeout must be more than zero" });
          refIssue(issues, nodes, id, (n as any).timeoutNext, "timeout path");
        } else issues.push({ nodeId: id, message: "unknown delay type" });
        refIssue(issues, nodes, id, (n as any).next, "next");
        break;
      }
      case "branch": {
        if (!Array.isArray(n.branches) || n.branches.length === 0) issues.push({ nodeId: id, message: "the branch needs at least one path" });
        for (const b of Array.isArray(n.branches) ? n.branches : []) {
          if (!Array.isArray(b?.conditions) || !b.conditions.length) issues.push({ nodeId: id, message: `path "${b?.label ?? b?.id ?? ""}" needs a condition` });
          for (const c of Array.isArray(b?.conditions) ? b.conditions : []) {
            if (!c?.field || !(OPERATORS as readonly string[]).includes(String(c.op))) issues.push({ nodeId: id, message: "a condition needs a field and a valid operator" });
          }
          refIssue(issues, nodes, id, b?.next, "a path");
        }
        refIssue(issues, nodes, id, n.noneNext, "the otherwise path");
        break;
      }
      case "value_branch": {
        if (!n.field) issues.push({ nodeId: id, message: "pick the field to branch on" });
        if (!Array.isArray(n.cases) || !n.cases.length) issues.push({ nodeId: id, message: "add at least one value" });
        for (const c of Array.isArray(n.cases) ? n.cases : []) refIssue(issues, nodes, id, c?.next, "a value path");
        refIssue(issues, nodes, id, n.noneNext, "the otherwise path");
        break;
      }
      case "goto": {
        if (!n.target || !nodes[n.target]) issues.push({ nodeId: id, message: "go to points to a step that does not exist" });
        break;
      }
      default:
        issues.push({ nodeId: id, message: `unknown step kind ${(n as any).kind}` });
    }
  }
  // A loop with no delay in it would spin until the daily step limit stops it.
  for (const cyc of delaylessCycles(nodes)) issues.push({ nodeId: cyc, message: "this loop has no delay in it" });
  const goalObj = goal as any;
  if (goalObj && (!Array.isArray(goalObj.conditions) || !goalObj.conditions.length)) issues.push({ nodeId: null, message: "the goal needs a condition" });
  const s = settings as any;
  if (s && s.reenroll && !["never", "after_complete", "always"].includes(s.reenroll)) issues.push({ nodeId: null, message: "unknown re-enrollment setting" });
  return issues;
}

export function successorsOf(n: GraphNode): Array<string | null> {
  switch (n.kind) {
    case "action": return [n.next];
    case "delay": return n.mode === "until_event" ? [n.next, n.timeoutNext] : [n.next];
    case "branch": return [...(n.branches ?? []).map((b) => b.next), n.noneNext];
    case "value_branch": return [...(n.cases ?? []).map((c) => c.next), n.noneNext];
    case "goto": return [n.target];
    default: return [];
  }
}

function delaylessCycles(nodes: Record<string, GraphNode>): string[] {
  const out = new Set<string>();
  const state = new Map<string, number>();
  const stack: string[] = [];
  const visit = (id: string) => {
    state.set(id, 1); stack.push(id);
    const n = nodes[id];
    for (const nx of n ? successorsOf(n) : []) {
      if (!nx || !nodes[nx]) continue;
      if (state.get(nx) === 1) {
        const cyc = stack.slice(stack.indexOf(nx));
        if (!cyc.some((c) => nodes[c]?.kind === "delay")) out.add(nx);
      } else if (!state.get(nx)) visit(nx);
    }
    stack.pop(); state.set(id, 2);
  };
  for (const id of Object.keys(nodes)) if (!state.get(id)) visit(id);
  return [...out];
}

// ---- v1 -> v2 conversion -------------------------------------------------------
const V1_CHECK_FIELD: Record<string, string> = {
  still_in_stage: "check.still_in_stage",
  documents_still_rejected: "check.documents_still_rejected",
  no_reply_since_start: "check.no_reply_since_start",
};

function v1Filters(trigger: string, conditions: unknown): Condition[] {
  let out: Condition[] = [];
  if (Array.isArray(conditions)) out = conditions.filter((c: any) => c && typeof c.field === "string").map((c: any) => ({ field: c.field, op: c.op ?? "eq", value: c.value }));
  else if (conditions && typeof conditions === "object") {
    out = Object.entries(conditions as Record<string, unknown>).map(([k, v]) => ({ field: k === "toStage" ? "to_stage" : k === "fromStage" ? "from_stage" : k, op: "eq", value: v }));
  }
  // The website form now reports source "website_form"; keep old "website" filters matching it.
  if (trigger === "contact.created") {
    out = out.map((f) => {
      const vals = Array.isArray(f.value) ? f.value : [f.value];
      if (f.field === "source" && vals.includes("website") && !vals.includes("website_form")) return { ...f, op: f.op === "eq" ? "in" : f.op, value: [...vals, "website_form"] };
      return f;
    });
  }
  return out;
}

function v1StepToNode(step: Record<string, any>, id: string): GraphNode | null {
  const p = step;
  switch (step.type) {
    case "wait": return { id, kind: "delay", mode: "duration", params: { amount: Number(p.amount) || 1, unit: ["minutes", "hours", "days"].includes(p.unit) ? p.unit : "hours" }, next: null };
    case "create_task": return { id, kind: "action", action: "create_task", params: { title: p.title ?? "Follow up", body: p.body ?? undefined, type: p.taskType ?? "TODO", priority: p.priority ?? "MEDIUM", dueInHours: p.dueHours != null ? Number(p.dueHours) : p.dueDays != null ? Number(p.dueDays) * 24 : 24, assignee: p.assignTo === "user" && p.userId ? p.userId : "owner" }, next: null };
    case "send_sms": return { id, kind: "action", action: "send_sms", params: { body: p.body ?? "", kind: p.purpose === "transactional" ? "transactional" : "marketing" }, next: null };
    case "send_push":
    case "notify_client": return { id, kind: "action", action: "notify_client", params: { title: p.title ?? "Update from Boreal", body: p.body ?? "" }, next: null };
    case "notify_staff": return { id, kind: "action", action: "notify_staff", params: { channel: "in_app", to: p.userId || "owner", message: p.body ?? "Automation update" }, next: null };
    case "assign_owner": return p.mode === "user" && p.userId
      ? { id, kind: "action", action: "assign_owner", params: { userId: p.userId }, next: null }
      : { id, kind: "action", action: "rotate_owner", params: { userIds: Array.isArray(p.userIds) ? p.userIds : [] }, next: null };
    case "add_tag": return { id, kind: "action", action: "add_tag", params: { tag: p.tag ?? "" }, next: null };
    case "add_note": return { id, kind: "action", action: "add_note", params: { body: p.body ?? "" }, next: null };
    case "team_post": return { id, kind: "action", action: "team_post", params: { channel: p.channel ?? "", body: p.body ?? "" }, next: null };
    case "check": return { id, kind: "branch", branches: [{ id: id + "-yes", label: "Continue", logic: "all", conditions: [{ field: V1_CHECK_FIELD[String(p.check)] ?? "check.unknown", op: "eq", value: true }], next: null }], noneNext: null };
    default: return null;
  }
}

/** v1 rule (trigger_type + conditions + steps/actions) -> v2 graph, settings and goal. Linear chain; a "check" becomes a branch whose otherwise path ends. */
export function convertV1Rule(rule: { trigger_type?: string | null; conditions?: unknown; steps?: unknown; actions?: unknown; reenroll?: string | null; test_mode?: boolean | null }): { graph: Graph; settings: Settings; goal: Goal } {
  const trigger = String(rule.trigger_type ?? "manual");
  const stepsRaw = Array.isArray(rule.steps) && rule.steps.length ? rule.steps : Array.isArray(rule.actions) ? rule.actions : [];
  const nodes: Record<string, GraphNode> = {};
  const order: string[] = [];
  for (const s of stepsRaw as any[]) {
    if (!s || typeof s.type !== "string") continue;
    const id = "n" + (order.length + 1);
    const node = v1StepToNode(s.type === "create_task" && s.dueDays && s.dueHours == null ? { ...s, dueHours: Number(s.dueDays) * 24 } : s, id);
    if (!node) continue;
    nodes[id] = node;
    order.push(id);
  }
  order.forEach((id, i) => {
    const n = nodes[id]!;
    const nx = order[i + 1] ?? null;
    if (n.kind === "branch") n.branches[0]!.next = nx;
    else if (n.kind !== "goto" && n.kind !== "value_branch") (n as any).next = nx;
  });
  return {
    graph: { triggers: [{ type: trigger, filters: v1Filters(trigger, rule.conditions), filterLogic: "all" }], startNodeId: order[0] ?? null, nodes },
    settings: { ...DEFAULT_SETTINGS, reenroll: (["never", "after_complete", "always"].includes(String(rule.reenroll)) ? rule.reenroll : "never") as Settings["reenroll"], testMode: !!rule.test_mode },
    goal: null,
  };
}
