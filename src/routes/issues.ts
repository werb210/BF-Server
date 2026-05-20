import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
const router = Router();
router.get("/issues", requireAuth, async (req: any, res) => {
  const source = String(req.query.source ?? "");
  const kind = String(req.query.kind ?? "");
  const status = String(req.query.status ?? "open");
  const filters: string[] = ["status = $1"];
  const values: any[] = [status];
  let i = 2;
  if (source) { filters.push(`source = $${i++}`); values.push(source); }
  if (kind) { filters.push(`kind = $${i++}`); values.push(kind); }
  const r = await pool.query(`SELECT id, source, kind, description, contact_email, contact_phone,
            page_url, screenshot_url, status, created_at
       FROM issues WHERE ${filters.join(" AND ")} ORDER BY created_at DESC LIMIT 200`, values);
  res.json({ issues: r.rows });
});
router.patch("/issues/:id", requireAuth, async (req: any, res) => {
  const next = String(req.body?.status ?? "");
  if (!["open", "acknowledged", "resolved"].includes(next)) return res.status(400).json({ error: "invalid_status" });
  await pool.query(`UPDATE issues SET status = $1 WHERE id = $2`, [next, req.params.id]);
  res.json({ ok: true });
});
export default router;
