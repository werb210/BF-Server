// BF_SERVER_AUTOMATION_ENGINE_v1 - CRUD for automation rules.
import express from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";

const router = express.Router();

router.get("/", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(`SELECT id::text, name, trigger_type, conditions, actions, enabled, created_at FROM automation_rules WHERE silo = $1 ORDER BY created_at DESC`, [silo]);
  respondOk(res, rows);
}));

router.post("/", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body ?? {};
  const name = String(b.name ?? "").trim();
  const trigger = String(b.trigger_type ?? "").trim();
  if (!name || !trigger) return res.status(400).json({ error: { code: "name_and_trigger_required" } });
  const conditions = b.conditions && typeof b.conditions === "object" ? b.conditions : {};
  const actions = Array.isArray(b.actions) ? b.actions : [];
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const enabled = typeof b.enabled === "boolean" ? b.enabled : true;
  const { rows } = await pool.query(
    `INSERT INTO automation_rules (silo, name, trigger_type, conditions, actions, enabled, created_by) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7) RETURNING id::text, name, trigger_type, conditions, actions, enabled, created_at`,
    [silo, name, trigger, JSON.stringify(conditions), JSON.stringify(actions), enabled, userId]);
  respondOk(res, rows[0]);
}));

router.patch("/:id", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body ?? {};
  const { rows } = await pool.query(
    `UPDATE automation_rules SET name = COALESCE($3, name), conditions = COALESCE($4::jsonb, conditions), actions = COALESCE($5::jsonb, actions), enabled = COALESCE($6, enabled), updated_at = now() WHERE id = $1::uuid AND silo = $2 RETURNING id::text, name, trigger_type, conditions, actions, enabled, created_at`,
    [req.params.id, silo, b.name ?? null, b.conditions ? JSON.stringify(b.conditions) : null, Array.isArray(b.actions) ? JSON.stringify(b.actions) : null, typeof b.enabled === "boolean" ? b.enabled : null]);
  if (!rows[0]) return res.status(404).json({ error: { code: "not_found" } });
  respondOk(res, rows[0]);
}));

router.delete("/:id", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(`DELETE FROM automation_rules WHERE id = $1::uuid AND silo = $2`, [req.params.id, silo]);
  respondOk(res, { deleted: r.rowCount ?? 0 });
}));

export default router;
