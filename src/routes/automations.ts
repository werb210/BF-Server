// BF_SERVER_AUTOMATION_ENGINE_v1 - CRUD for automation rules.
// BF_SERVER_BLOCK_v616 - steps, catalog, enrollments, step log, manual enroll / test run.
import express from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { ACTIONS, CHECKS, TRIGGERS } from "../modules/automation/catalog.js";
// BF_SERVER_v786_WORKFLOW_GRAPH - v2 workflows: graph, settings, goal.
import { convertV1Rule, normalizeSettings, validateGraph, type Issue, type ValidateRefs } from "../modules/automation/graph.js";
import { catalogStatic, libraryItems } from "../modules/automation/library.js";

const router = express.Router();
// BF_SERVER_v787_WORKFLOW_ACCESS - Admin and Marketing read and write every workflow route;
// Staff keeps read-only access. Lender / Referrer / client tokens are refused.
const writers = requireAuthorization({ roles: [ROLES.ADMIN, ROLES.MARKETING] });
const readers = requireAuthorization({ roles: [ROLES.ADMIN, ROLES.MARKETING, ROLES.STAFF] });
// BF_SERVER_v788_STAFF_ENROLL - Staff may manually enroll a contact; every other write stays Admin / Marketing.
const enrollers = requireAuthorization({ roles: [ROLES.ADMIN, ROLES.MARKETING, ROLES.STAFF] });
const COLS = `id::text, name, description, silo, trigger_type, conditions, actions, steps, enabled, reenroll, test_mode, version, template_key, graph, settings, goal, schema_version, created_at, updated_at`;
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

const SILOS = new Set(["BF", "BI", "SLF"]);
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

/** Body silo when an admin names a valid one, else the selected silo. */
function siloFor(req: any): string {
  const b = String(req.body?.silo ?? "").toUpperCase();
  return SILOS.has(b) ? b : resolveSiloFromRequest(req);
}

async function refsFor(silo: string): Promise<ValidateRefs & { templateRows: { email: Array<{ id: string; name: string }>; sms: Array<{ id: string; name: string }> }; listRows: Array<{ id: string; name: string }>; workflowRows: Array<{ id: string; name: string }> }> {
  const t = await pool.query(
    `SELECT id::text AS id, name, channel FROM marketing_template WHERE silo = $1 AND channel IN ('email', 'sms')
     UNION ALL
     SELECT id::text AS id, name, channel FROM message_templates WHERE silo = $1 AND channel IN ('email', 'sms') AND COALESCE(is_snippet, false) = false
     ORDER BY name`, [silo]);
  const l = await pool.query(`SELECT id::text AS id, name FROM automation_lists WHERE silo = $1 ORDER BY name`, [silo]);
  const w = await pool.query(`SELECT id::text AS id, name FROM automation_rules WHERE silo = $1 ORDER BY name`, [silo]);
  const email = t.rows.filter((r: any) => r.channel === "email").map((r: any) => ({ id: r.id, name: r.name }));
  const sms = t.rows.filter((r: any) => r.channel === "sms").map((r: any) => ({ id: r.id, name: r.name }));
  return {
    templates: { email: email.map((x) => x.id), sms: sms.map((x) => x.id) },
    lists: l.rows.map((r: any) => r.id),
    workflows: w.rows.map((r: any) => r.id),
    templateRows: { email, sms }, listRows: l.rows, workflowRows: w.rows,
  };
}

/** A v2 body (graph) or a legacy v1 body (trigger_type + steps), as graph / settings / goal. */
function workflowFromBody(b: any): { graph: any; settings: any; goal: any } | { error: string } {
  if (b.graph && typeof b.graph === "object") {
    return { graph: b.graph, settings: normalizeSettings(b.settings), goal: b.goal && typeof b.goal === "object" ? b.goal : null };
  }
  const trigger = String(b.trigger_type ?? "").trim();
  if (!trigger) return { error: "graph_required" };
  if (!TRIGGER_KEYS.has(trigger) && trigger !== "manual") return { error: "unknown_trigger" };
  const bad = validateSteps(Array.isArray(b.steps) ? b.steps : []);
  if (bad) return { error: bad };
  const conv = convertV1Rule({ trigger_type: trigger, conditions: b.conditions ?? [], steps: b.steps ?? [], reenroll: b.reenroll, test_mode: !!b.test_mode });
  return { graph: conv.graph, settings: b.settings ? normalizeSettings(b.settings) : conv.settings, goal: conv.goal };
}

const firstTrigger = (graph: any) => String(graph?.triggers?.[0]?.type ?? "manual");

router.get("/catalog", readers, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const refs = await refsFor(silo);
  respondOk(res, { ...catalogStatic(), templates: refs.templateRows, lists: refs.listRows, workflows: refs.workflowRows,
    // v1 builder keys, kept while the old builder is still deployed.
    legacy: { triggers: TRIGGERS, actions: ACTIONS, checks: CHECKS } });
}));

router.get("/library", readers, safeHandler(async (_req: any, res: any) => {
  respondOk(res, libraryItems());
}));

router.post("/from-library", writers, safeHandler(async (req: any, res: any) => {
  const silo = siloFor(req);
  const item = libraryItems().find((x) => x.key === String(req.body?.key ?? ""));
  if (!item) return res.status(404).json({ error: { code: "unknown_template" } });
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const { rows } = await pool.query(
    `INSERT INTO automation_rules (silo, name, description, trigger_type, conditions, actions, steps, enabled, reenroll, test_mode, created_by, template_key, graph, settings, goal, schema_version)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, false, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, 2) RETURNING ${COLS}`,
    [silo, item.name, item.description, firstTrigger(item.graph), item.settings.reenroll, item.settings.testMode, userId, "library_" + item.key,
     JSON.stringify(item.graph), JSON.stringify(item.settings), item.goal ? JSON.stringify(item.goal) : null]);
  respondOk(res, { ...rows[0], issues: validateGraph(item.graph, item.settings, item.goal, await refsFor(silo)) });
}));

// BF_SERVER_v786_WORKFLOW_GRAPH - describe a workflow in words; OpenAI drafts the graph, which is
// validated strictly before it is returned. Nothing is saved.
router.post("/draft-from-text", writers, safeHandler(async (req: any, res: any) => {
  const prompt = String(req.body?.prompt ?? "").trim().slice(0, 4000);
  const silo = siloFor(req);
  if (!prompt) return res.status(400).json({ error: { code: "prompt_required" } });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: { code: "openai_not_configured" } });
  const refs = await refsFor(silo);
  const { draftWorkflowFromText } = await import("../modules/automation/draftFromText.js");
  const out = await draftWorkflowFromText(prompt, { ...catalogStatic(), templates: refs.templateRows, lists: refs.listRows, workflows: refs.workflowRows });
  if ("error" in out) return res.status(422).json({ error: { code: "draft_failed", message: out.error }, issues: [{ nodeId: null, message: out.error }] });
  const issues = validateGraph(out.graph, out.settings, out.goal, refs);
  if (issues.length) return res.status(422).json({ error: { code: "draft_invalid" }, issues, draft: out });
  respondOk(res, out);
}));

// ---- lists ------------------------------------------------------------------------------
router.get("/lists", readers, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(
    `SELECT l.id::text AS id, l.name, l.silo, l.created_at, (SELECT count(*)::int FROM automation_list_members m WHERE m.list_id = l.id) AS member_count
       FROM automation_lists l WHERE l.silo = $1 ORDER BY l.name`, [silo]);
  respondOk(res, rows);
}));

router.post("/lists", writers, safeHandler(async (req: any, res: any) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: { code: "name_required" } });
  const { rows } = await pool.query(`INSERT INTO automation_lists (name, silo) VALUES ($1, $2) RETURNING id::text AS id, name, silo, created_at`, [name, siloFor(req)]);
  respondOk(res, rows[0]);
}));

router.delete("/lists/:listId", writers, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  if (!isUuid(req.params.listId)) return res.status(400).json({ error: { code: "invalid_id" } });
  const r = await pool.query(`DELETE FROM automation_lists WHERE id = $1::uuid AND silo = $2`, [req.params.listId, silo]);
  if (r.rowCount) await pool.query(`DELETE FROM automation_list_members WHERE list_id = $1::uuid`, [req.params.listId]);
  respondOk(res, { deleted: r.rowCount ?? 0 });
}));

router.get("/", readers, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(
    `SELECT ${COLS},
            (SELECT COUNT(*)::int FROM automation_enrollments e WHERE e.rule_id = r.id AND e.status = 'active') AS active_count,
            (SELECT COUNT(*)::int FROM automation_enrollments e WHERE e.rule_id = r.id) AS total_count
       FROM automation_rules r WHERE silo = $1 ORDER BY created_at DESC`, [silo]);
  respondOk(res, rows);
}));

router.get("/enrollments/:enrollmentId/log", readers, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(
    `SELECT l.step_index, l.step_type, l.node_id, l.outcome, l.detail, l.created_at
       FROM automation_step_log l JOIN automation_enrollments e ON e.id = l.enrollment_id
      WHERE l.enrollment_id = $1::uuid AND e.silo = $2 ORDER BY l.id ASC`, [req.params.enrollmentId, silo]);
  respondOk(res, rows);
}));

router.post("/enrollments/:enrollmentId/stop", writers, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(`UPDATE automation_enrollments SET status = 'stopped', completed_at = now(), wait_event = NULL WHERE id = $1::uuid AND silo = $2 AND status = 'active'`, [req.params.enrollmentId, silo]);
  respondOk(res, { stopped: r.rowCount ?? 0 });
}));

router.get("/:id", readers, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  if (!isUuid(req.params.id)) return res.status(404).json({ error: { code: "not_found" } });
  const { rows } = await pool.query(`SELECT ${COLS} FROM automation_rules WHERE id = $1::uuid AND silo = $2`, [req.params.id, silo]);
  if (!rows[0]) return res.status(404).json({ error: { code: "not_found" } });
  respondOk(res, rows[0]);
}));

router.post("/", writers, safeHandler(async (req: any, res: any) => {
  const silo = siloFor(req);
  const b = req.body ?? {};
  const name = String(b.name ?? "").trim();
  if (!name) return res.status(400).json({ error: { code: "name_required" } });
  const wf = workflowFromBody(b);
  if ("error" in wf) return res.status(400).json({ error: { code: wf.error === "unknown_trigger" || wf.error === "graph_required" ? wf.error : "invalid_steps", message: wf.error } });
  const issues: Issue[] = validateGraph(wf.graph, wf.settings, wf.goal, await refsFor(silo));
  const enabled = b.enabled === true;
  if (enabled && issues.length) return res.status(422).json({ error: { code: "fix_issues_before_enabling" }, issues });
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const { rows } = await pool.query(
    `INSERT INTO automation_rules (silo, name, description, trigger_type, conditions, actions, steps, enabled, reenroll, test_mode, created_by, graph, settings, goal, schema_version)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, '[]'::jsonb, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, 2) RETURNING ${COLS}`,
    [silo, name.slice(0, 120), b.description ? String(b.description).slice(0, 1000) : null, firstTrigger(wf.graph), JSON.stringify(Array.isArray(b.steps) ? b.steps : []),
     enabled, wf.settings.reenroll, !!wf.settings.testMode, userId, JSON.stringify(wf.graph), JSON.stringify(wf.settings), wf.goal ? JSON.stringify(wf.goal) : null]);
  respondOk(res, { ...rows[0], issues });
}));

router.patch("/:id", writers, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body ?? {};
  if (!isUuid(req.params.id)) return res.status(404).json({ error: { code: "not_found" } });
  const cur = await pool.query(`SELECT ${COLS} FROM automation_rules WHERE id = $1::uuid AND silo = $2`, [req.params.id, silo]);
  const rule = cur.rows[0];
  if (!rule) return res.status(404).json({ error: { code: "not_found" } });
  let graph = rule.graph, settings = rule.settings, goal = rule.goal;
  if (b.graph !== undefined || b.trigger_type !== undefined || b.steps !== undefined) {
    const wf = workflowFromBody({ trigger_type: rule.trigger_type, conditions: rule.conditions, ...b, graph: b.graph ?? (b.steps !== undefined || b.trigger_type !== undefined ? undefined : rule.graph) });
    if ("error" in wf) return res.status(400).json({ error: { code: wf.error === "unknown_trigger" ? wf.error : "invalid_steps", message: wf.error } });
    graph = wf.graph;
    if (b.settings === undefined && b.graph === undefined) settings = wf.settings;
  }
  if (b.settings !== undefined) settings = normalizeSettings(b.settings);
  else if (b.reenroll !== undefined || b.test_mode !== undefined) settings = normalizeSettings({ ...(settings ?? {}), ...(REENROLL.has(b.reenroll) ? { reenroll: b.reenroll } : {}), ...(typeof b.test_mode === "boolean" ? { testMode: b.test_mode } : {}) });
  if (b.goal !== undefined) goal = b.goal && typeof b.goal === "object" ? b.goal : null;
  const issues = validateGraph(graph, settings, goal, await refsFor(rule.silo ?? silo));
  const enabling = b.enabled === true;
  if (enabling && issues.length) return res.status(422).json({ error: { code: "fix_issues_before_enabling" }, issues });
  const logicChanged = b.graph !== undefined || b.steps !== undefined || b.trigger_type !== undefined || b.goal !== undefined;
  const s = normalizeSettings(settings);
  const { rows } = await pool.query(
    `UPDATE automation_rules SET
        name = COALESCE($3, name), description = COALESCE($4, description), trigger_type = $5,
        steps = COALESCE($6::jsonb, steps), enabled = COALESCE($7, enabled),
        reenroll = $8, test_mode = $9, graph = $10::jsonb, settings = $11::jsonb, goal = $12::jsonb, schema_version = 2,
        version = version + CASE WHEN $13 THEN 1 ELSE 0 END, silo = COALESCE($14, silo), updated_at = now()
      WHERE id = $1::uuid AND silo = $2 RETURNING ${COLS}`,
    [req.params.id, silo, typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 120) : null, b.description ?? null, firstTrigger(graph),
     Array.isArray(b.steps) ? JSON.stringify(b.steps) : null, typeof b.enabled === "boolean" ? b.enabled : null,
     s.reenroll, s.testMode, JSON.stringify(graph), JSON.stringify(s), goal ? JSON.stringify(goal) : null, logicChanged,
     SILOS.has(String(b.silo ?? "").toUpperCase()) ? String(b.silo).toUpperCase() : null]);
  if (!rows[0]) return res.status(404).json({ error: { code: "not_found" } });
  respondOk(res, { ...rows[0], issues });
}));

router.delete("/:id", writers, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  if (!isUuid(req.params.id)) return res.status(404).json({ error: { code: "not_found" } });
  const r = await pool.query(`DELETE FROM automation_rules WHERE id = $1::uuid AND silo = $2`, [req.params.id, silo]);
  respondOk(res, { deleted: r.rowCount ?? 0 });
}));

router.post("/:id/validate", readers, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  if (!isUuid(req.params.id)) return res.status(404).json({ error: { code: "not_found" } });
  const { rows } = await pool.query(`SELECT ${COLS} FROM automation_rules WHERE id = $1::uuid AND silo = $2`, [req.params.id, silo]);
  const rule = rows[0];
  if (!rule) return res.status(404).json({ error: { code: "not_found" } });
  // An unsaved draft can be validated by sending it; otherwise the saved workflow is checked.
  const b = req.body ?? {};
  const graph = b.graph ?? rule.graph;
  respondOk(res, { issues: validateGraph(graph, b.settings ?? rule.settings, b.goal !== undefined ? b.goal : rule.goal, await refsFor(rule.silo ?? silo)) });
}));

router.get("/:id/performance", readers, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  if (!isUuid(req.params.id)) return res.status(404).json({ error: { code: "not_found" } });
  const r = await pool.query(`SELECT id FROM automation_rules WHERE id = $1::uuid AND silo = $2`, [req.params.id, silo]);
  if (!r.rows[0]) return res.status(404).json({ error: { code: "not_found" } });
  const c = await pool.query(
    `SELECT count(*)::int AS enrolled,
            count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'completed')::int AS completed,
            count(*) FILTER (WHERE goal_reached_at IS NOT NULL)::int AS goal_reached
       FROM automation_enrollments WHERE rule_id = $1::uuid AND test_mode = false`, [req.params.id]);
  // BF_SERVER_v792_WORKFLOW_TEST_RUN - test runs never count toward performance.
  const n = await pool.query(
    `SELECT l.node_id, count(DISTINCT l.enrollment_id)::int AS entered,
            count(DISTINCT l.enrollment_id) FILTER (WHERE l.outcome = 'failed')::int AS failed
       FROM automation_step_log l JOIN automation_enrollments e ON e.id = l.enrollment_id
      WHERE l.rule_id = $1::uuid AND l.node_id IS NOT NULL AND e.test_mode = false GROUP BY l.node_id`, [req.params.id]);
  const byNode: Record<string, { entered: number; failed: number }> = {};
  for (const row of n.rows) byNode[row.node_id] = { entered: Number(row.entered) || 0, failed: Number(row.failed) || 0 };
  const k = c.rows[0] ?? {};
  respondOk(res, { enrolled: Number(k.enrolled) || 0, active: Number(k.active) || 0, completed: Number(k.completed) || 0, goalReached: Number(k.goal_reached) || 0, byNode });
}));

router.get("/:id/history", readers, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  if (!isUuid(req.params.id)) return res.status(404).json({ error: { code: "not_found" } });
  const contactId = isUuid(req.query?.contactId) ? String(req.query.contactId) : null;
  const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 500);
  const { rows } = await pool.query(
    `SELECT e.id::text AS id, e.status, e.contact_id::text AS contact_id, e.application_id, e.current_node_id, e.path, e.wait_event, e.wait_timeout_at,
            e.goal_reached_at, e.next_run_at, e.last_error, e.test_mode, e.created_at, e.completed_at,
            COALESCE(c.name, c.email, c.phone, e.application_id) AS label
       FROM automation_enrollments e LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE e.rule_id = $1::uuid AND e.silo = $2 AND ($3::text IS NULL OR e.contact_id::text = $3)
      ORDER BY e.created_at DESC LIMIT $4`, [req.params.id, silo, contactId, limit]);
  respondOk(res, rows);
}));

router.get("/:id/enrollments", readers, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(
    `SELECT e.id::text, e.status, e.current_step, e.current_node_id, e.next_run_at, e.last_error, e.test_mode, e.created_at, e.completed_at,
            e.contact_id::text AS contact_id, e.application_id, COALESCE(c.name, c.phone, e.application_id) AS label
       FROM automation_enrollments e LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE e.rule_id = $1::uuid AND e.silo = $2 ORDER BY e.created_at DESC LIMIT 200`, [req.params.id, silo]);
  respondOk(res, rows);
}));

// Manual trigger: Admin / Marketing / Staff enroll a contact (or application). testMode runs every action as a dry run.
// BF_SERVER_v792_WORKFLOW_TEST_RUN - a test run walks the whole workflow at once (works while the workflow
// is Off) and returns its step log: { enrollmentId, outcome, testMode: true, steps: [...] }.
router.post("/:id/enroll", enrollers, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const contactId = isUuid(req.body?.contactId) ? req.body.contactId : null;
  const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId : null;
  if (!contactId && !applicationId) return res.status(400).json({ error: { code: "contact_or_application_required" } });
  if (!isUuid(req.params.id)) return res.status(404).json({ error: { code: "not_found" } });
  const r = await pool.query(`SELECT ${COLS} FROM automation_rules WHERE id = $1::uuid AND silo = $2`, [req.params.id, silo]);
  let rule = r.rows[0];
  if (!rule) return res.status(404).json({ error: { code: "not_found" } });
  const { defaultDeps, runEnrollment, buildContext } = await import("../modules/automation/automationEngine.js");
  const { enrollGraph } = await import("../modules/automation/graphEngine.js");
  const deps = await defaultDeps();
  if (!rule.graph) {
    const conv = convertV1Rule(rule);
    rule = { ...rule, graph: conv.graph, settings: conv.settings, goal: conv.goal };
  }
  const ctx = await buildContext(deps.query, { trigger: "manual", silo, contactId, applicationId, data: { source: "manual" } });
  const testMode = req.body?.testMode === true;
  const settings = testMode ? { ...normalizeSettings(rule.settings), testMode: true } : rule.settings;
  const enrollmentId = await enrollGraph(deps, { ...rule, settings }, ctx, { ignoreReenroll: true });
  if (!enrollmentId) return res.status(409).json({ error: { code: "not_enrolled" } });
  const outcome = await runEnrollment(deps, enrollmentId);
  if (!testMode) return respondOk(res, { enrollmentId, outcome });
  const log = await pool.query(
    `SELECT step_index, node_id, step_type, outcome, detail FROM automation_step_log WHERE enrollment_id = $1::uuid ORDER BY id ASC`, [enrollmentId]);
  respondOk(res, { enrollmentId, outcome, testMode: true, steps: log.rows });
}));

export default router;
