import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";
// BF_SERVER_BLOCK_BI_ROUND5_CRM_SILO_RESOLVE_v1
import { resolveSiloFromRequest } from "../../middleware/silo.js";

const router = express.Router({ mergeParams: true });

router.get("/", safeHandler(async (req: any, res: any) => {
  const isContact = req.baseUrl?.includes("/contacts/");
  const id = req.params.id;
  const col = isContact ? "contact_id" : "company_id";
  const silo = resolveSiloFromRequest(req);
  const sql = `
    SELECT 'note' AS kind, id::text, created_at AS ts,
           NULL::text AS title, body AS body, NULL::text AS extra
      FROM crm_notes WHERE ${col} = $1 AND silo = $2
    UNION ALL
    SELECT 'task' AS kind, id::text, created_at AS ts,
           title, notes AS body, status AS extra
      FROM crm_tasks WHERE ${col} = $1 AND silo = $2
    UNION ALL
    SELECT 'call' AS kind, id::text, created_at AS ts,
           direction AS title, notes AS body, twilio_call_sid AS extra
      FROM crm_call_log WHERE ${col} = $1 AND silo = $2
    UNION ALL
    SELECT 'email' AS kind, id::text, created_at AS ts,
           subject AS title, NULL::text AS body, from_address AS extra
      FROM crm_email_log WHERE ${col} = $1 AND silo = $2
    UNION ALL
    SELECT 'meeting' AS kind, id::text, created_at AS ts,
           title, attendee_description AS body, location AS extra
      FROM crm_meetings WHERE ${col} = $1 AND silo = $2
    ORDER BY ts DESC LIMIT 500`;
  const { rows } = await pool.query(sql, [id, silo]);
  respondOk(res, rows);
}));

export default router;
