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
  const contactCommsUnion = isContact ? `
    UNION ALL
    -- BF_SERVER_BLOCK_BI_ROUND8_TIMELINE_v1 -- SMS from communications_messages.
    -- The phone match works in both directions: outbound (to_phone matches
    -- the contact) and inbound (from_phone matches the contact). Body is
    -- truncated to 240 chars at the SQL level to keep the timeline payload
    -- compact; the contact drawer renders this as a summary line.
    SELECT
      'sms' AS kind, cm.id::text, cm.created_at AS ts,
      CASE WHEN cm.direction = 'outbound' THEN 'SMS sent' ELSE 'SMS received' END AS title,
      LEFT(COALESCE(cm.body, ''), 240) AS body,
      cm.sender_user_id::text AS extra
    FROM communications_messages cm
    JOIN contacts c ON c.id = $1 AND c.silo = $2
    WHERE cm.silo = $2
      AND (
        cm.to_phone   = c.phone_e164 OR
        cm.from_phone = c.phone_e164
      )
    UNION ALL
    -- BF_SERVER_BLOCK_BI_ROUND8_TIMELINE_v1 -- Voice SDK calls from call_logs.
    -- Same direction-agnostic match. duration_seconds renders as part of
    -- the summary so the drawer shows "Call 2m14s" instead of just "Call".
    SELECT
      'call' AS kind, cl.id::text, cl.started_at AS ts,
      CASE
        WHEN cl.direction = 'outbound' THEN 'Call placed'
        ELSE 'Call received'
      END || COALESCE(
        ' (' || (cl.duration_seconds / 60)::text || 'm' ||
        (cl.duration_seconds % 60)::text || 's)',
        ''
      ) AS title,
      cl.recording_url AS body,
      cl.agent_user_id::text AS extra
    FROM call_logs cl
    JOIN contacts c ON c.id = $1 AND c.silo = $2
    WHERE cl.silo = $2
      AND (
        cl.to_phone   = c.phone_e164 OR
        cl.from_phone = c.phone_e164
      )
  ` : ``;

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
    ${contactCommsUnion}
    ORDER BY ts DESC LIMIT 500`;
  const { rows } = await pool.query(sql, [id, silo]);
  respondOk(res, rows);
}));

export default router;
