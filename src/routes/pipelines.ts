// BF_SERVER_v870_CRM_DATA_MODEL - /api/pipelines: extra pipelines and custom stages (ported from KS-server #47 without
// the plan limit). The lending pipeline ("lending") is listed too, with its locked system stages. Extra pipelines
// belong to the request's silo (?silo= / X-Silo), like the lending board.
//   GET  /                              staff: every pipeline and its stages, can_create
//   POST /                              Admin: create             { name, stages: [{ name, color, probability, outcome }] }
//   PUT  /:id                           Admin: rename / edit stages (a stage with deals in it cannot be removed)
//   POST /:id/archive                   Admin: only an empty pipeline
//   PUT  /lending/probabilities         Admin: { "Received": 10, ... } (the lending stages stay locked)
//   GET  /:id/board?team_id=            staff: an extra pipeline's stages and cards (record visibility applies)
//   GET  /application/:id               staff: the deal's pipeline and stage
//   POST /move                          staff: { application_id, pipeline_id ("lending" or an id), stage_id? }
//   GET  /report?pipeline_id=&team_id=  staff: open deals by stage, amount and weighted amount, won and lost
import { Router } from "express";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { actorId, auditFor } from "../settingsPack/common.js";
import { canSeeRecord, narrowToOwners, ownerFilterSql, scopeForRequest, teamOwnerIds } from "../visibility/scope.js";
import {
  LENDING_ID, PIPELINE_LIMIT, canAddPipeline, cleanSilo, extraPipelines, lendingPipeline, moveApplication, pipelineById, saveLendingProbabilities,
  validatePipeline, weighted, writeStages, type Q,
} from "../pipelines/pipelines.js";

const router = Router();
const db = (): Q => pool as unknown as Q;
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.MARKETING, ROLES.OPS] })];
const admin = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const siloOf = (req: any) => cleanSilo(resolveSiloFromRequest(req));

router.get("/", ...staff, safeHandler(async (req: any, res: any) => {
  const silo = siloOf(req);
  const extra = await extraPipelines(db(), silo, { includeArchived: req.user?.role === "Admin" && String(req.query?.include_archived ?? "") === "1" });
  const active = extra.filter((p) => !p.archived_at).length;
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, silo, limit: PIPELINE_LIMIT, can_create: req.user?.role === "Admin" && canAddPipeline(active), pipelines: [await lendingPipeline(db()), ...extra] });
}));

router.post("/", ...admin, safeHandler(async (req: any, res: any) => {
  const v = validatePipeline(req.body ?? {});
  if (!v.ok) return res.status(400).json({ ok: false, error: "validation_error", message: Object.values(v.errors)[0], errors: v.errors });
  const silo = siloOf(req);
  const active = (await db().query(`SELECT count(*)::int AS n FROM pipelines WHERE archived_at IS NULL AND silo = $1`, [silo])).rows[0]?.n ?? 0;
  if (!canAddPipeline(Number(active))) {
    return res.status(409).json({ ok: false, error: "pipeline_limit", limit: PIPELINE_LIMIT, message: `You can have at most ${PIPELINE_LIMIT} extra pipelines. Archive one first.` });
  }
  let id: string;
  try {
    id = (await db().query(`INSERT INTO pipelines (name, silo, position, created_by) VALUES ($1, $3, (SELECT COALESCE(max(position), 0) + 1 FROM pipelines WHERE silo = $3), $2::uuid) RETURNING id::text AS id`, [v.name, actorId(req), silo])).rows[0].id;
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "duplicate_name", message: "There is already a pipeline with that name.", errors: { name: "There is already a pipeline with that name." } });
    throw err;
  }
  await writeStages(db(), id, v.stages);
  await auditFor(req, "pipeline.created", { name: v.name, silo, stages: v.stages.map((s) => s.name) }, { type: "pipeline", id });
  res.status(201).json({ ok: true, pipeline: await pipelineById(db(), id) });
}));

router.put("/lending/probabilities", ...admin, safeHandler(async (req: any, res: any) => {
  const probabilities = await saveLendingProbabilities(db(), req.body ?? {}, actorId(req));
  await auditFor(req, "pipeline.lending_probabilities", { probabilities }, { type: "pipeline", id: LENDING_ID });
  res.json({ ok: true, pipeline: await lendingPipeline(db()) });
}));

router.put("/:id", ...admin, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (id === LENDING_ID) return res.status(409).json({ ok: false, error: "locked", message: "The lending pipeline's stages are built in and cannot be changed. You can set their probabilities." });
  const p = await pipelineById(db(), id);
  if (!p || p.archived_at || p.silo !== siloOf(req)) return res.status(404).json({ ok: false, error: "not_found" });
  const v = validatePipeline(req.body ?? {});
  if (!v.ok) return res.status(400).json({ ok: false, error: "validation_error", message: Object.values(v.errors)[0], errors: v.errors });
  try { await db().query(`UPDATE pipelines SET name = $2, updated_at = now() WHERE id = $1::uuid`, [id, v.name]); } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "duplicate_name", message: "There is already a pipeline with that name." });
    throw err;
  }
  const w = await writeStages(db(), id, v.stages);
  if (!w.ok) return res.status(409).json({ ok: false, error: "stage_in_use", message: w.error });
  await auditFor(req, "pipeline.updated", { name: v.name, stages: v.stages.map((s) => s.name) }, { type: "pipeline", id });
  res.json({ ok: true, pipeline: await pipelineById(db(), id) });
}));

router.post("/:id/archive", ...admin, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  const found = id === LENDING_ID ? null : await pipelineById(db(), id);
  const p = found && found.silo === siloOf(req) ? found : null;
  if (!p) return res.status(id === LENDING_ID ? 409 : 404).json({ ok: false, error: id === LENDING_ID ? "locked" : "not_found", message: id === LENDING_ID ? "The lending pipeline cannot be archived." : undefined });
  const deals = (await db().query(`SELECT count(*)::int AS n FROM applications WHERE pipeline_id = $1::uuid`, [id])).rows[0]?.n ?? 0;
  if (Number(deals) > 0) return res.status(409).json({ ok: false, error: "not_empty", message: `Move its ${deals} deal${deals === 1 ? "" : "s"} to another pipeline first.` });
  await db().query(`UPDATE pipelines SET archived_at = now(), updated_at = now() WHERE id = $1::uuid`, [id]);
  await auditFor(req, "pipeline.archived", { name: p.name }, { type: "pipeline", id });
  res.json({ ok: true });
}));

async function scopedWhere(req: any, alias: string, values: unknown[]): Promise<string> {
  let scope = await scopeForRequest(req, db() as any);
  const team = String(req.query?.team_id ?? "").trim();
  if (team) scope = narrowToOwners(scope, await teamOwnerIds(db() as any, team));
  return ownerFilterSql(scope, "application", alias, values);
}

router.get("/report", ...staff, safeHandler(async (req: any, res: any) => {
  const pid = String(req.query?.pipeline_id ?? LENDING_ID);
  const p = await pipelineById(db(), pid);
  if (!p || (!p.system && p.silo !== siloOf(req))) return res.status(404).json({ ok: false, error: "not_found" });
  const values: unknown[] = [siloOf(req)];
  const visible = await scopedWhere(req, "a", values);
  const stageCol = p.system ? "a.pipeline_state" : "a.pipeline_stage_id::text";
  let where: string;
  if (p.system) where = `a.pipeline_id IS NULL AND COALESCE(a.pipeline_state, '') NOT IN ('draft', 'Draft', '') AND (a.parent_application_id IS NULL OR a.source IN ('closing_costs_companion', 'capital_and_equipment_leg'))`;
  else { values.push(p.id); where = `a.pipeline_id = $${values.length}::uuid`; }
  const r = await db().query(
    `SELECT ${stageCol} AS stage, count(*)::int AS deals, COALESCE(sum(COALESCE(a.funded_amount, a.requested_amount)), 0)::float AS amount
       FROM applications a WHERE UPPER(a.silo) = $1 AND ${where} AND ${visible} GROUP BY 1`, values);
  const by = new Map(r.rows.map((x: any) => [String(x.stage), x]));
  const stages = p.stages.map((s) => {
    const row: any = by.get(s.id) ?? { deals: 0, amount: 0 };
    return { id: s.id, name: s.name, color: s.color, probability: s.probability, outcome: s.outcome, deals: Number(row.deals), amount: Number(row.amount), weighted: weighted(Number(row.amount), s.probability) };
  });
  const open = stages.filter((s) => s.outcome === "open");
  const sum = (xs: typeof stages, k: "deals" | "amount" | "weighted") => xs.reduce((n, x) => n + x[k], 0);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true, pipeline: { id: p.id, name: p.name, system: p.system }, stages,
    totals: {
      open_deals: sum(open, "deals"), open_amount: sum(open, "amount"), weighted_amount: Math.round(sum(open, "weighted") * 100) / 100,
      won_deals: sum(stages.filter((s) => s.outcome === "won"), "deals"), won_amount: sum(stages.filter((s) => s.outcome === "won"), "amount"),
      lost_deals: sum(stages.filter((s) => s.outcome === "lost"), "deals"),
    },
  });
}));

router.get("/:id/board", ...staff, safeHandler(async (req: any, res: any) => {
  const p = await pipelineById(db(), String(req.params.id));
  if (!p || p.system || p.archived_at || p.silo !== siloOf(req)) return res.status(404).json({ ok: false, error: "not_found", message: "Open the lending pipeline from the Pipeline page." });
  const values: unknown[] = [p.id];
  const visible = await scopedWhere(req, "a", values);
  const r = await db().query(
    `SELECT a.id::text AS id, COALESCE(NULLIF(btrim(a.business_legal_name), ''), NULLIF(btrim(a.name), ''), c.name, 'Unnamed') AS name,
            a.pipeline_stage_id::text AS stage_id, a.pipeline_stage_entered_at AS stage_entered_at, a.requested_amount, a.funded_amount,
            a.product_category, a.pipeline_state AS lending_stage, a.owner_user_id::text AS owner_user_id, u.first_name AS owner_first_name, u.last_name AS owner_last_name,
            a.contact_id::text AS contact_id, COALESCE(NULLIF(btrim(ct.name), ''), ct.email) AS contact_name, a.updated_at
       FROM applications a
       LEFT JOIN companies c ON c.id = a.company_id
       LEFT JOIN contacts ct ON ct.id = a.contact_id
       LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.pipeline_id = $1::uuid AND ${visible}
      ORDER BY a.pipeline_stage_entered_at DESC NULLS LAST LIMIT 500`, values);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, pipeline: p, cards: r.rows });
}));

router.get("/application/:id", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  const scope = await scopeForRequest(req, db() as any);
  if (!(await canSeeRecord(db() as any, scope, "application", id))) return res.status(404).json({ ok: false, error: "not_found" });
  const r = (await db().query(
    `SELECT a.pipeline_id::text AS pipeline_id, a.pipeline_stage_id::text AS stage_id, a.pipeline_state, s.name AS stage_name
       FROM applications a LEFT JOIN pipeline_stages s ON s.id = a.pipeline_stage_id WHERE a.id::text = $1`, [id])).rows[0];
  if (!r) return res.status(404).json({ ok: false, error: "not_found" });
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, pipeline_id: r.pipeline_id ?? LENDING_ID, stage_id: r.pipeline_id ? r.stage_id : r.pipeline_state, stage: r.pipeline_id ? r.stage_name : r.pipeline_state });
}));

router.post("/move", ...staff, safeHandler(async (req: any, res: any) => {
  const applicationId = String(req.body?.application_id ?? "").trim();
  const toPipeline = String(req.body?.pipeline_id ?? "").trim();
  const toStage = String(req.body?.stage_id ?? "").trim() || null;
  if (!applicationId || !toPipeline) return res.status(400).json({ ok: false, error: "validation_error", message: "Choose a deal and a pipeline." });
  const scope = await scopeForRequest(req, db() as any);
  if (!(await canSeeRecord(db() as any, scope, "application", applicationId))) return res.status(404).json({ ok: false, error: "not_found", message: "Application not found" });
  const r = await moveApplication(db(), applicationId, toPipeline, toStage, actorId(req));
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error, message: r.message });
  await auditFor(req, "pipeline.deal_moved", { application_id: applicationId, pipeline_id: r.pipeline_id, stage: r.stage }, { type: "application", id: applicationId });
  res.json(r);
}));

export default router;
