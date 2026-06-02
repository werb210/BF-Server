// v693: message templates (email | message | sms). Shared team library + personal.
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getSilo } from "../middleware/silo.js";

const router = Router();
router.use(requireAuth);

const CHANNELS = new Set(["email", "message", "sms"]);
const isAdmin = (req: any) => String(req.user?.role ?? "").toLowerCase() === "admin";

router.get("/", safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const channel = req.query.channel ? String(req.query.channel) : null;
  const { rows } = await pool.query(
    `SELECT id, channel, name, subject, body_html, body_text, shared, owner_user_id, created_at, updated_at
       FROM message_templates
      WHERE silo IN ('BF', $1)
        AND (shared = true OR owner_user_id = $2)
        AND ($3::text IS NULL OR channel = $3)
      ORDER BY name ASC`,
    [silo, userId, channel]
  );
  res.json({ items: rows });
}));

router.post("/", safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const channel = String(req.body?.channel ?? "").toLowerCase();
  if (!CHANNELS.has(channel)) return res.status(400).json({ error: "invalid_channel" });
  const name = String(req.body?.name ?? "").slice(0, 200);
  if (!name) return res.status(400).json({ error: "name required" });
  const subject = req.body?.subject != null ? String(req.body.subject).slice(0, 400) : null;
  const bodyHtml = req.body?.body_html != null ? String(req.body.body_html).slice(0, 50000) : null;
  const bodyText = req.body?.body_text != null ? String(req.body.body_text).slice(0, 50000) : null;
  const shared = req.body?.shared === false ? false : true;
  const { rows } = await pool.query(
    `INSERT INTO message_templates (channel, name, subject, body_html, body_text, shared, owner_user_id, silo, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7)
     RETURNING id, channel, name, subject, body_html, body_text, shared, owner_user_id, created_at, updated_at`,
    [channel, name, subject, bodyHtml, bodyText, shared, userId, silo]
  );
  res.status(201).json({ item: rows[0] });
}));

router.put("/:id", safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const cur = await pool.query(`SELECT owner_user_id, shared FROM message_templates WHERE id = $1 AND silo = $2 LIMIT 1`, [req.params.id, silo]);
  const row = cur.rows[0];
  if (!row) return res.status(404).json({ error: "not_found" });
  if (!(row.owner_user_id === userId || row.shared === true || isAdmin(req))) return res.status(403).json({ error: "forbidden" });
  const name = req.body?.name != null ? String(req.body.name).slice(0, 200) : null;
  const subject = req.body?.subject != null ? String(req.body.subject).slice(0, 400) : null;
  const bodyHtml = req.body?.body_html != null ? String(req.body.body_html).slice(0, 50000) : null;
  const bodyText = req.body?.body_text != null ? String(req.body.body_text).slice(0, 50000) : null;
  const shared = typeof req.body?.shared === "boolean" ? req.body.shared : null;
  const { rows } = await pool.query(
    `UPDATE message_templates SET
        name = COALESCE($3, name),
        subject = COALESCE($4, subject),
        body_html = COALESCE($5, body_html),
        body_text = COALESCE($6, body_text),
        shared = COALESCE($7, shared),
        updated_at = now()
      WHERE id = $1 AND silo = $2
      RETURNING id, channel, name, subject, body_html, body_text, shared, owner_user_id, created_at, updated_at`,
    [req.params.id, silo, name, subject, bodyHtml, bodyText, shared]
  );
  res.json({ item: rows[0] });
}));

router.delete("/:id", safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const cur = await pool.query(`SELECT owner_user_id, shared FROM message_templates WHERE id = $1 AND silo = $2 LIMIT 1`, [req.params.id, silo]);
  const row = cur.rows[0];
  if (!row) return res.status(404).json({ error: "not_found" });
  if (!(row.owner_user_id === userId || row.shared === true || isAdmin(req))) return res.status(403).json({ error: "forbidden" });
  await pool.query(`DELETE FROM message_templates WHERE id = $1 AND silo = $2`, [req.params.id, silo]);
  res.json({ ok: true });
}));

export default router;
