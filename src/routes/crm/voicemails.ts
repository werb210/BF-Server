// BF_SERVER_BLOCK_v830_VOICEMAILS_LIST
// GET /api/crm/voicemails — recent voicemails for the active silo, newest first,
// joined to contacts for a caller name. Powers the central Voicemail inbox.
import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";
import { resolveSiloFromRequest } from "../../middleware/silo.js";

const router = express.Router();

router.get("/", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `SELECT v.id, v.recording_url, v.call_sid, v.created_at,
            v.contact_id,
            c.name  AS contact_name,
            c.phone AS contact_phone
       FROM voicemails v
       LEFT JOIN contacts c ON c.id = v.contact_id
      WHERE (c.silo = $1 OR c.silo IS NULL)
      ORDER BY v.created_at DESC
      LIMIT 200`,
    [silo],
  ).catch(() => ({ rows: [] as any[] }));
  respondOk(res, r.rows ?? []);
}));

export default router;
