// BF_MINI_PORTAL_NOTES_v47 — adds PATCH, DELETE, and @mention extraction to CRM notes.
import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";
import { parseAndResolveMentions } from "../../services/notes/mentions.js";

const router = express.Router({ mergeParams: true });

router.get("/", safeHandler(async (req: any, res: any) => {
  const { contactId, companyId } = resolveScope(req);
  const silo = (req.user?.silo ?? "BF").toString().toUpperCase();
  const where: string[] = ["n.silo = $1", "n.is_deleted = false"];
  const params: unknown[] = [silo];
  if (contactId) { params.push(contactId); where.push(`n.contact_id = $${params.length}`); }
  if (companyId) { params.push(companyId); where.push(`n.company_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT n.*, u.first_name || ' ' || u.last_name AS owner_name
     FROM crm_notes n LEFT JOIN users u ON u.id = n.owner_id
     WHERE ${where.join(" AND ")} ORDER BY n.created_at DESC LIMIT 200`,
    params,
  );
  respondOk(res, rows);
}));

router.post("/", safeHandler(async (req: any, res: any) => {
  const { contactId, companyId } = resolveScope(req);
  const body = (req.body?.body ?? "").toString().trim();
  if (!body) return res.status(400).json({ error: "body required" });
  const silo = (req.user?.silo ?? "BF").toString().toUpperCase();
  const mentions = await parseAndResolveMentions(body);
  const { rows } = await pool.query(
    `INSERT INTO crm_notes (body, owner_id, contact_id, company_id, silo, mentions)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [body, req.user?.id ?? req.user?.userId ?? null, contactId, companyId, silo, mentions],
  );
  res.status(201).json({ ok: true, data: rows[0] });
}));

router.patch("/:noteId", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.noteId ?? "").trim();
  const body = (req.body?.body ?? "").toString().trim();
  if (!id) return res.status(400).json({ error: "noteId required" });
  if (!body) return res.status(400).json({ error: "body required" });
  const mentions = await parseAndResolveMentions(body);
  const { rows } = await pool.query(
    `UPDATE crm_notes SET body=$1, mentions=$2, updated_at=now()
      WHERE id=$3 AND is_deleted=false RETURNING *`,
    [body, mentions, id],
  );
  if (!rows[0]) return res.status(404).json({ error: "Note not found" });
  res.status(200).json({ ok: true, data: rows[0] });
}));

router.delete("/:noteId", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.noteId ?? "").trim();
  if (!id) return res.status(400).json({ error: "noteId required" });
  const { rows } = await pool.query(
    `UPDATE crm_notes SET is_deleted=true, updated_at=now()
      WHERE id=$1 AND is_deleted=false RETURNING id`,
    [id],
  );
  if (!rows[0]) return res.status(404).json({ error: "Note not found" });
  res.status(200).json({ ok: true, id });
}));

function resolveScope(req: any): { contactId: string | null; companyId: string | null } {
  const isContact = req.baseUrl?.includes("/contacts/");
  const id = req.params.id;
  return isContact ? { contactId: id, companyId: req.body?.companyId ?? null }
    : { companyId: id, contactId: req.body?.contactId ?? null };
}

export default router;
