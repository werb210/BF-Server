// BF_SERVER_AUTOMATION_ENGINE_v1 - CRUD for automation rules.
// BF_SERVER_BLOCK_v616 - steps, catalog, enrollments, step log, manual enroll / test run.
import express from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { ACTIONS, CHECKS, FIELDS, OPERATORS, STAGES, TRIGGERS } from "../modules/automation/catalog.js";

const router = express.Router();
const adminOnly = requireAuthorization({ roles: [ROLES.ADMIN] });
const staff = requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] });
const COLS = `id::text, name, description, trigger_type, conditions, actions, steps, enabled, reenroll, test_mode, version, template_key, created_at, updated_at`;
const REENROLL = new Set(["never", "always", "after_complete"]);
const TRIGGER_KEYS = new Set<string>(TRIGGERS.map((t) => t.key));
const STEP_KEYS = new Set<string>(ACTIONS.map((a) => a.key));

export function validateSteps(steps: unknown): string | null {
  if (!Array.isArray(steps)) return "steps must be a list";
  if (steps.length > 25) return "at most 25 steps";
  for (const [i, s] of steps.entries()) {
    if (!s || typeof s !== "object" || !STEP_KEYS.has(String((s as any).type))) return `step ${i + 1}: unknown type`;
    const st = s as any;
    if (st.type === "wait" && !(Number(st.amount) > 0)) return `step ${i + 1}: wait needs an amount`;
    if (st.type === "send_sms" && !String(st.body ?? "").trim()) return `step ${i + 1}: text needs a message`;
    if (st.type === "notify_client" && !String(st.body ?? "").trim()) return `step ${i + 1}: notice needs a message`;
    if (st.type === "create_task" && !String(st.title ?? "").trim()) return `step ${i + 1}: task needs a title`;
    if (st.type === "check" && !CHECKS.some((c) => c.key === st.check)) return `step ${i + 1}: unknown check`;
  }
  return null;
}

router.get("/catalog", staff, safeHandler(async (_req: any, res: any) => {
  respondOk(res, { triggers: TRIGGERS, fields: FIELDS, operators: OPERATORS, actions: ACTIONS, checks: CHECKS, stages: STAGES });
}));

router.get("/", staff, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(
    `SELECT ${COLS},
            (SELECT COUNT(*)::int FROM automation_enrollments e WHERE e.rule_id = r.id AND e.status = 'active') AS active_count,
            (SELECT COUNT(*)::int FROM automation_enrollments e WHERE e.rule_id = r.id) AS total_count
       FROM automation_rules r WHERE silo = $1 ORDER BY created_at DESC`, [silo]);
  respondOk(res, rows);
}));

router.get("/enrollments/:enrollmentId/log", staff, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(
    `SELECT l.step_index, l.step_type, l.outcome, l.detail, l.created_at
       FROM automation_step_log l JOIN automation_enrollments e ON e.id = l.enrollment_id
      WHERE l.enrollment_id = $1::uuid AND e.silo = $2 ORDER BY l.id ASC`, [req.params.enrollmentId, silo]);
  respondOk(res, rows);
}));

router.post("/enrollments/:enrollmentId/stop", staff, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(`UPDATE automation_enrollments SET status = 'stopped', completed_at = now() WHERE id = $1::uuid AND silo = $2 AND status = 'active'`, [req.params.enrollmentId, silo]);
  respondOk(res, { stopped: r.rowCount ?? 0 });
}));

router.get("/:id", staff, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(`SELECT ${COLS} FROM automation_rules WHERE id = $1::uuid AND silo = $2`, [req.params.id, silo]);
  if (!rows[0]) return res.status(404).json({ error: { code: "not_found" } });
  respondOk(res, rows[0]);
}));

router.post("/", adminOnly, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body ?? {};
  const name = String(b.name ?? "").trim();
  const trigger = String(b.trigger_type ?? "").trim();
  if (!name || !trigger) return res.status(400).json({ error: { code: "name_and_trigger_required" } });
  if (!TRIGGER_KEYS.has(trigger)) return res.status(400).json({ error: { code: "unknown_trigger" } });
  const steps = Array.isArray(b.steps) ? b.steps : [];
  const bad = validateSteps(steps);
  if (bad) return res.status(400).json({ error: { code: "invalid_steps", message: bad } });
  const conditions = Array.isArray(b.conditions) ? b.conditions : [];
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const { rows } = await pool.query(
    `INSERT INTO automation_rules (silo, name, description, trigger_type, conditions, actions, steps, enabled, reenroll, test_mode, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, '[]'::jsonb, $6::jsonb, $7, $8, $9, $10) RETURNING ${COLS}`,
    [silo, name.slice(0, 120), b.description ? String(b.description).slice(0, 1000) : null, trigger, JSON.stringify(conditions), JSON.stringify(steps),
     typeof b.enabled === "boolean" ? b.enabled : false, REENROLL.has(b.reenroll) ? b.reenroll : "never", !!b.test_mode, userId]);
  respondOk(res, rows[0]);
}));

router.patch("/:id", adminOnly, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body ?? {};
  if (b.trigger_type !== undefined && !TRIGGER_KEYS.has(String(b.trigger_type))) return res.status(400).json({ error: { code: "unknown_trigger" } });
  if (b.steps !== undefined) {
    const bad = validateSteps(b.steps);
    if (bad) return res.status(400).json({ error: { code: "invalid_steps", message: bad } });
  }
  const logicChanged = b.steps !== undefined || b.conditions !== undefined || b.trigger_type !== undefined;
  const { rows } = await pool.query(
    `UPDATE automation_rules SET
        name = COALESCE($3, name), description = COALESCE($4, description), trigger_type = COALESCE($5, trigger_type),
        conditions = COALESCE($6::jsonb, conditions), steps = COALESCE($7::jsonb, steps), enabled = COALESCE($8, enabled),
        reenroll = COALESCE($9, reenroll), test_mode = COALESCE($10, test_mode),
        version = version + CASE WHEN $11 THEN 1 ELSE 0 END, updated_at = now()
      WHERE id = $1::uuid AND silo = $2 RETURNING ${COLS}`,
    [req.params.id, silo, b.name ?? null, b.description ?? null, b.trigger_type ?? null,
     Array.isArray(b.conditions) ? JSON.stringify(b.conditions) : null, Array.isArray(b.steps) ? JSON.stringify(b.steps) : null,
     typeof b.enabled === "boolean" ? b.enabled : null, REENROLL.has(b.reenroll) ? b.reenroll : null,
     typeof b.test_mode === "boolean" ? b.test_mode : null, logicChanged]);
  if (!rows[0]) return res.status(404).json({ error: { code: "not_found" } });
  respondOk(res, rows[0]);
}));

router.delete("/:id", adminOnly, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(`DELETE FROM automation_rules WHERE id = $1::uuid AND silo = $2`, [req.params.id, silo]);
  respondOk(res, { deleted: r.rowCount ?? 0 });
}));

router.get("/:id/enrollments", staff, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(
    `SELECT e.id::text, e.status, e.current_step, e.next_run_at, e.last_error, e.test_mode, e.created_at, e.completed_at,
            e.contact_id::text AS contact_id, e.application_id, COALESCE(c.name, c.phone, e.application_id) AS label
       FROM automation_enrollments e LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE e.rule_id = $1::uuid AND e.silo = $2 ORDER BY e.created_at DESC LIMIT 200`, [req.params.id, silo]);
  respondOk(res, rows);
}));

// Manual trigger: staff enroll a contact or application. testMode runs every step as a dry run.
router.post("/:id/enroll", staff, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const contactId = typeof req.body?.contactId === "string" ? req.body.contactId : null;
  const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId : null;
  if (!contactId && !applicationId) return res.status(400).json({ error: { code: "contact_or_application_required" } });
  const r = await pool.query(`SELECT ${COLS} FROM automation_rules WHERE id = $1::uuid AND silo = $2`, [req.params.id, silo]);
  const rule = r.rows[0];
  if (!rule) return res.status(404).json({ error: { code: "not_found" } });
  const { buildContext, defaultDeps, runEnrollment, stepsOf } = await import("../modules/automation/automationEngine.js");
  const deps = await defaultDeps();
  const ctx = await buildContext(deps.query, { trigger: "manual", silo, contactId, applicationId });
  const ins = await pool.query(
    `INSERT INTO automation_enrollments (rule_id, rule_version, silo, contact_id, application_id, context, steps, test_mode)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::jsonb, $7::jsonb, $8) RETURNING id::text AS id`,
    [rule.id, rule.version, silo, (ctx.contact_id as string | null) ?? null, applicationId, JSON.stringify(ctx), JSON.stringify(stepsOf(rule)), !!req.body?.testMode || !!rule.test_mode]);
  const outcome = await runEnrollment(deps, ins.rows[0].id);
  respondOk(res, { enrollmentId: ins.rows[0].id, outcome });
}));

export default router;
