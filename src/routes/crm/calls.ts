import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";

const router = express.Router({ mergeParams: true });

router.get("/", safeHandler(async (req: any, res: any) => {
  const { contactId, companyId } = resolveScope(req);
  const silo = resolveSiloFromRequest(req);
  const where: string[] = ["silo = $1"]; const params: unknown[] = [silo];
  if (contactId) { params.push(contactId); where.push(`contact_id = $${params.length}`); }
  if (companyId) { params.push(companyId); where.push(`company_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT * FROM crm_call_log WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC LIMIT 200`,
    params,
  );
  respondOk(res, rows);
}));

router.post("/", safeHandler(async (req: any, res: any) => {
  const { contactId, companyId } = resolveScope(req);
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const silo = resolveSiloFromRequest(req);
  const b = req.body ?? {};
  const { rows } = await pool.query(
    `INSERT INTO crm_call_log
       (direction,from_number,to_number,twilio_call_sid,duration_sec,
        recording_url,notes,owner_id,contact_id,company_id,silo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      b.direction ?? "outbound",
      b.from_number ?? null,
      b.to_number ?? null,
      b.twilio_call_sid ?? null,
      b.duration_sec ?? null,
      b.recording_url ?? null,
      b.notes ?? null,
      userId,
      contactId,
      companyId,
      silo,
    ],
  );
  res.status(201).json({ ok: true, data: rows[0] });
}));

function resolveScope(req: any): { contactId: string | null; companyId: string | null } {
  const isContact = req.baseUrl?.includes("/contacts/");
  const id = req.params.id;
  return isContact ? { contactId: id, companyId: req.body?.companyId ?? null }
    : { companyId: id, contactId: req.body?.contactId ?? null };
}

export default router;
