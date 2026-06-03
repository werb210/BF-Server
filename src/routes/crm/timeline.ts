// BF_SERVER_BLOCK_47_v1 -- timeline union uses only real columns on
// communications_messages. Pre-fix: deployed Block 32 union
// referenced a non-existent sender column on this table.
// communications_messages columns that exist: direction, status,
// body, staff_name, phone_number, from_number, to_number,
// twilio_sid, cta_label, cta_action, created_at.
import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";
import { resolveSiloFromRequest } from "../../middleware/silo.js"; // BF_SERVER_BLOCK_v735

const router = express.Router({ mergeParams: true });

router.get("/", safeHandler(async (req: any, res: any) => {
  const isContact = req.baseUrl?.includes("/contacts/");
  const id = req.params.id;
  const col = isContact ? "contact_id" : "company_id";
  // BF_SERVER_BLOCK_v735 — read the SELECTED silo (X-Silo), not the user's
  // primary. Every write stamps the selected silo, so a BI contact's timeline
  // was empty for a BF-primary admin. This aligns the read so BOTH BF and BI
  // contacts surface their own activity. (Per-tab lists already do this.)
  const silo = resolveSiloFromRequest(req);

  // Notes / tasks / calls / emails / meetings come from CRM tables;
  // SMS and inbound/outbound messages come from communications_messages
  // (filtered by contact_id when isContact, ignored for companies
  // since that table has no company_id column).
  const sql = isContact
    ? `
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
        -- BF_SERVER_BLOCK_v706_READ_RECEIPTS — read receipts as a separate
        -- "Opened:" entry (reuses the 'email' kind, so no UI change).
        SELECT 'email' AS kind, ('opened-' || id::text) AS id, opened_at AS ts,
               ('Opened: ' || subject) AS title, NULL::text AS body, from_address AS extra
          FROM crm_email_log WHERE ${col} = $1 AND silo = $2 AND opened_at IS NOT NULL
        UNION ALL
        SELECT 'meeting' AS kind, id::text, created_at AS ts,
               title, attendee_description AS body, location AS extra
          FROM crm_meetings WHERE ${col} = $1 AND silo = $2
        UNION ALL
        -- BF_SERVER_BLOCK_v733 — dialer calls live in call_events (contact
        -- resolved by phone at call time). Surface them as 'call' so calls
        -- placed anywhere (dialer or CRM) appear on the timeline.
        SELECT 'call' AS kind, id::text, occurred_at AS ts,
               direction AS title,
               ('Call ' || coalesce(event_type, '')) AS body,
               coalesce(to_number, from_number) AS extra
          FROM call_events
         WHERE contact_id = $1 AND (silo = $2 OR silo IS NULL)
           AND event_type IN ('call.ended','call.missed','call.failed','call.declined')
        UNION ALL
        -- BF_SERVER_BLOCK_47_v1 -- SMS / chat messages from
        -- communications_messages. Title = "SMS in" / "SMS out".
        -- staff_name surfaces who sent outbound (NULL on inbound).
        SELECT 'sms' AS kind, id::text, created_at AS ts,
               CASE WHEN direction = 'inbound' THEN 'SMS in' ELSE 'SMS out' END AS title,
               body AS body,
               COALESCE(staff_name, from_number, phone_number) AS extra
          FROM communications_messages
         WHERE contact_id = $1 AND silo = $2
        ORDER BY ts DESC LIMIT 500`
    : `
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
        -- BF_SERVER_BLOCK_v706_READ_RECEIPTS — read receipts as a separate
        -- "Opened:" entry (reuses the 'email' kind, so no UI change).
        SELECT 'email' AS kind, ('opened-' || id::text) AS id, opened_at AS ts,
               ('Opened: ' || subject) AS title, NULL::text AS body, from_address AS extra
          FROM crm_email_log WHERE ${col} = $1 AND silo = $2 AND opened_at IS NOT NULL
        UNION ALL
        SELECT 'meeting' AS kind, id::text, created_at AS ts,
               title, attendee_description AS body, location AS extra
          FROM crm_meetings WHERE ${col} = $1 AND silo = $2
        ORDER BY ts DESC LIMIT 500`;

  const { rows } = await pool.query(sql, [id, silo]);
  respondOk(res, rows);
}));

export default router;
