// BF_SERVER_BLOCK_v616 - automation types and context (split from the engine so each block stays small).
import { conditionsMatch } from "./conditions.js";

export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

export type AutomationEvent = {
  trigger: string;
  silo?: string | null;
  applicationId?: string | null;
  contactId?: string | null;
  fromStage?: string | null;
  toStage?: string | null;
  data?: Record<string, unknown>;
};

export type Step = Record<string, any> & { type: string };

export type EngineDeps = {
  query: Query;
  sendSms: (to: string, message: string) => Promise<void>;
  notifyClient: (input: { silo: string; phone: string; contactId: string | null; applicationId: string | null; title: string; body: string }) => Promise<"app" | "sms" | "none">;
  now: () => Date;
  // BF_SERVER_v786_WORKFLOW_GRAPH - v2 actions. Optional so v1 callers and tests keep working.
  sendEmail?: (input: { to: string; subject: string; html: string; contactId: string | null; from?: string | null }) => Promise<{ ok: boolean; error?: string }>;
  sendStaffEmail?: (input: { to: string; subject: string; html: string }) => Promise<{ ok: boolean; error?: string }>;
  // BF_SERVER_v789_SSRF_GUARD - called with redirect "manual"; headers (location) are read on a 3xx.
  httpFetch?: (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect?: "manual" }) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null } }>;
  setApplicationStage?: (applicationId: string, stage: string) => Promise<void>;
};

export const SYSTEM_USER = "00000000-0000-0000-0000-000000000099";
export const FALLBACK_USER_SQL = `(SELECT id FROM users WHERE active = true AND id::text <> '${SYSTEM_USER}' ORDER BY (role = 'Admin') DESC, created_at ASC LIMIT 1)`;

/** Legacy rules stored plain actions; they become steps. */
export function stepsOf(rule: { steps?: unknown; actions?: unknown }): Step[] {
  const s = Array.isArray(rule.steps) ? rule.steps : [];
  if (s.length) return s.filter((x: any) => x && typeof x.type === "string");
  const a = Array.isArray(rule.actions) ? rule.actions : [];
  return a
    .filter((x: any) => x && typeof x.type === "string")
    .map((x: any) => (x.type === "send_push" ? { ...x, type: "notify_client" } : x.type === "create_task" && x.dueDays ? { ...x, dueHours: Number(x.dueDays) * 24 } : x));
}

export async function buildContext(q: Query, ev: AutomationEvent): Promise<Record<string, unknown>> {
  const ctx: Record<string, unknown> = { ...(ev.data ?? {}), from_stage: ev.fromStage ?? null, to_stage: ev.toStage ?? null };
  let contactId = ev.contactId ?? null;
  let silo = ev.silo ?? null;
  if (ev.applicationId) {
    const a = await q(
      `SELECT a.id::text AS id, a.silo, a.contact_id::text AS contact_id, a.pipeline_state, a.product_type, a.requested_amount,
              a.source, a.owner_user_id::text AS owner_user_id
         FROM applications a WHERE a.id::text = $1 LIMIT 1`, [ev.applicationId]);
    const app = a.rows[0];
    if (app) {
      silo = silo || app.silo;
      contactId = contactId || app.contact_id;
      const base = String(process.env.CLIENT_URL ?? "https://client.boreal.financial").replace(/\/$/, ""); // BF_SERVER_v786_WORKFLOW_GRAPH
      Object.assign(ctx, { stage: app.pipeline_state, pipeline_state: app.pipeline_state, product_type: app.product_type, requested_amount: app.requested_amount != null ? Number(app.requested_amount) : null, owner_user_id: app.owner_user_id,
        application_link: `${base}/application/${encodeURIComponent(String(app.id))}` });
      if (ctx.source === undefined) ctx.source = app.source;
    }
  }
  if (contactId) {
    const c = await q(
      `SELECT c.id::text AS id, c.silo, c.name, c.first_name, c.last_name, c.phone, c.email, c.tags, c.owner_id::text AS owner_id,
              c.company_name, c.job_title, c.lead_status, c.lifecycle_stage, c.status, c.role, c.created_at AS contact_created_at,
              u.first_name AS owner_first, u.last_name AS owner_last, u.email AS owner_email
         FROM contacts c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id::text = $1 LIMIT 1`, [contactId]);
    const ct = c.rows[0];
    if (ct) {
      silo = silo || ct.silo;
      const full = String(ct.name || [ct.first_name, ct.last_name].filter(Boolean).join(" ") || "").trim();
      Object.assign(ctx, {
        first_name: ct.first_name || full.split(" ")[0] || "there",
        full_name: full || ct.phone || "the client",
        phone: ct.phone, email: ct.email,
        contact_tag: Array.isArray(ct.tags) ? ct.tags : [],
        contact_owner_id: ct.owner_id,
        owner_name: [ct.owner_first, ct.owner_last].filter(Boolean).join(" ") || "our team",
        // BF_SERVER_v786_WORKFLOW_GRAPH - more fields for v2 conditions and personalization tokens.
        last_name: ct.last_name || full.split(" ").slice(1).join(" ") || "",
        company: ct.company_name || "", company_name: ct.company_name || null, job_title: ct.job_title ?? null,
        lead_status: ct.lead_status ?? null, lifecycle_stage: ct.lifecycle_stage ?? null, contact_status: ct.status ?? null, contact_role: ct.role ?? null,
        tags: Array.isArray(ct.tags) ? ct.tags : [], owner_id: ct.owner_id ?? null, owner_email: ct.owner_email ?? null,
      });
      if (ctx.application_link === undefined) ctx.application_link = String(process.env.CLIENT_URL ?? "https://client.boreal.financial").replace(/\/$/, "") + "/portal";
    }
  }
  if (ctx.document_type) ctx.document_type = String(ctx.document_type).replace(/_/g, " ");
  ctx.silo = String(silo || "BF").toUpperCase();
  ctx.contact_id = contactId;
  ctx.application_id = ev.applicationId ?? null;
  return ctx;
}

export async function emitWith(deps: EngineDeps, ev: AutomationEvent): Promise<string[]> {
  const q = deps.query;
  const ctx = await buildContext(q, ev);
  // BF_SERVER_v786_WORKFLOW_GRAPH - v1 only runs rules not yet converted to a graph.
  const rules = await q(
    `SELECT id::text AS id, conditions, steps, actions, reenroll, test_mode, version
       FROM automation_rules WHERE enabled = true AND silo = $1 AND trigger_type = $2 AND graph IS NULL`, [ctx.silo, ev.trigger]);
  const created: string[] = [];
  for (const rule of rules.rows) {
    if (!conditionsMatch(rule.conditions, ctx)) continue;
    const steps = stepsOf(rule);
    if (!steps.length) continue;
    const contactId = (ctx.contact_id as string | null) ?? null;
    const appId = (ctx.application_id as string | null) ?? null;
    if (!contactId && !appId) continue;
    if (rule.reenroll !== "always") {
      const prior = await q(
        `SELECT 1 FROM automation_enrollments
          WHERE rule_id = $1::uuid AND (($2::text IS NOT NULL AND contact_id::text = $2) OR ($3::text IS NOT NULL AND application_id = $3))
            ${rule.reenroll === "after_complete" ? "AND status = 'active'" : ""} LIMIT 1`, [rule.id, contactId, appId]);
      if (prior.rows.length) continue;
    }
    const ins = await q(
      `INSERT INTO automation_enrollments (rule_id, rule_version, silo, contact_id, application_id, context, steps, test_mode)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::jsonb, $7::jsonb, $8) RETURNING id::text AS id`,
      [rule.id, rule.version ?? 1, ctx.silo, contactId, appId, JSON.stringify(ctx), JSON.stringify(steps), !!rule.test_mode]);
    if (ins.rows[0]?.id) created.push(ins.rows[0].id);
  }
  return created;
}
