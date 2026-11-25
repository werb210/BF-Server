// BF_SERVER_CRM_SAVED_VIEWS_v1 - saved views on the CRM people list, shared by everyone in the business (X-Silo).
// Mounted at /api/crm/views behind requireAuth.
//   GET    /        this business's views, in order
//   POST   /        { name, filters } create, or replace the filters of the view with that name
//   DELETE /:id     remove (Admin, or whoever made it)
import express, { type Request, type Response } from "express";
import { pool } from "../db.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";

const router = express.Router();
const siloOf = (req: Request) => String(resolveSiloFromRequest(req)).toUpperCase();
const userId = (req: Request) => String((req as any).user?.userId ?? (req as any).user?.id ?? "") || null;
const isAdmin = (req: Request) => ["admin", "owner"].includes(String((req as any).user?.role ?? "").toLowerCase());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch((err) => {
    console.error("[crm-views] route failed", { path: req.path, message: (err as Error)?.message });
    if (!res.headersSent) res.status(500).json({ ok: false, error: "internal_error" });
  });
};

/** Only the list filters the people list understands are kept, as short strings. */
export function cleanFilters(raw: unknown): Record<string, unknown> {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["q", "tag", "ownerId", "stage", "marketing", "sortCol", "sortDir"]) {
    const v = String(f[k] ?? "").trim().slice(0, 300);
    if (v) out[k] = v;
  }
  if (Array.isArray(f.custom)) out.custom = f.custom.slice(0, 10).filter((x) => x && typeof x === "object");
  return out;
}

router.get("/", wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT id::text AS id, name, filters, created_by::text AS created_by FROM crm_saved_views WHERE silo = $1 ORDER BY position, lower(name)`,
    [siloOf(req)],
  );
  res.json({ ok: true, views: r.rows });
}));

router.post("/", wrap(async (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ ok: false, error: "name_required", message: "Give the view a name." });
  const filters = cleanFilters(req.body?.filters);
  const r = await pool.query(
    `INSERT INTO crm_saved_views (silo, name, filters, created_by, position)
     VALUES ($1, $2, $3::jsonb, $4, (SELECT coalesce(max(position), 0) + 1 FROM crm_saved_views WHERE silo = $1))
     ON CONFLICT (silo, lower(name)) DO UPDATE SET filters = EXCLUDED.filters, updated_at = now()
     RETURNING id::text AS id, name, filters`,
    [siloOf(req), name, JSON.stringify(filters), userId(req)],
  );
  res.status(201).json({ ok: true, view: r.rows[0] });
}));

router.delete("/:id", wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ ok: false, error: "not_found" });
  const r = await pool.query(
    `DELETE FROM crm_saved_views WHERE id = $1 AND silo = $2 AND ($3::boolean OR created_by::text = $4) RETURNING id`,
    [req.params.id, siloOf(req), isAdmin(req), userId(req) ?? ""],
  );
  if (!r.rowCount) return res.status(404).json({ ok: false, error: "not_found", message: "Only an Admin or whoever made it can remove a view." });
  res.json({ ok: true });
}));

export default router;
