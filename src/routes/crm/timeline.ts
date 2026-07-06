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
        -- BF_SERVER_RETIRE_CRM_TASKS_v1 - crm_tasks retired; timeline reads unified tasks only.
        -- BF_SERVER_TIMELINE_UNIFIED_TASKS_v1 - the HubSpot-style TaskPopup now
        -- writes to the unified tasks table (via /api/tasks), not crm_tasks.
        -- Without this branch a task created from a contact (BF or BI) never
        -- appeared on that contact's timeline. Same kind/shape so no UI change;
        -- body maps from tasks.body, status from tasks.status. Excludes
        -- soft-deleted rows.
        SELECT 'task' AS kind, id::text, created_at AS ts,
               title, body AS body, status AS extra
          FROM tasks WHERE ${col} = $1 AND silo = $2 AND deleted_at IS NULL
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
        SELECT 'email' AS kind, ('opened-' || e.id::text) AS id, e.opened_at AS ts,
               ('Opened: ' || e.subject ||
                 CASE WHEN oc.n > 1 THEN ' (' || oc.n || ' opens)' ELSE '' END) AS title,
               NULL::text AS body, e.from_address AS extra
          FROM crm_email_log e
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS n FROM email_open_events ev WHERE ev.email_log_id = e.id
          ) oc ON true
         WHERE e.${col} = $1 AND e.silo = $2 AND e.opened_at IS NOT NULL
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
        -- BF_SERVER_BLOCK_v762_RECORDING_TIMELINE — recorded calls + Voice
        -- Intelligence transcripts (both keyed by conference) surfaced on the
        -- contact timeline. body carries the transcript (or VI summary) and may
        -- be null until transcription finishes; extra carries the recording URL.
        SELECT 'recording' AS kind, cr.id::text, cr.created_at AS ts,
               'Call recording' AS title,
               COALESCE(ct.full_text, ct.voice_intelligence_summary) AS body,
               cr.url AS extra
          FROM call_recordings cr
          JOIN conferences cf ON cf.id = cr.conference_id
          LEFT JOIN call_transcripts ct ON ct.conference_id = cr.conference_id
         WHERE cf.contact_id = $1::text AND cf.silo = $2 AND cr.url IS NOT NULL
        UNION ALL
        -- BF_SERVER_VOICEMAIL_TIMELINE_v1 — saved voicemails on the contact
        -- timeline. kind 'call' so the existing UI renders it; title "Voicemail".
        SELECT 'call' AS kind, id::text, created_at AS ts,
               'Voicemail' AS title,
               NULL::text AS body,
               from_number AS extra
          FROM voicemails WHERE contact_id = $1 AND (silo = $2 OR silo IS NULL)
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
        UNION ALL
        -- BF_SERVER_BLOCK_v790 — sequence + engagement events on the contact record.
        SELECT (CASE WHEN event_type LIKE 'sms_%' THEN 'sms'
                     WHEN event_type = 'sequence_step_sent' THEN COALESCE(payload->>'channel','email')
                     WHEN event_type = 'attribution' THEN 'system'
                     ELSE 'email' END) AS kind,
               id::text, created_at AS ts,
               (CASE event_type
                  WHEN 'sequence_step_sent' THEN 'Sequence ' || COALESCE(payload->>'channel','') || ' sent'
                  WHEN 'email_open' THEN 'Email opened'
                  WHEN 'email_click' THEN 'Email link clicked'
                  WHEN 'email_bounce' THEN 'Email bounced'
                  WHEN 'email_dropped' THEN 'Email dropped'
                  WHEN 'email_spamreport' THEN 'Marked as spam'
                  WHEN 'email_unsubscribe' THEN 'Unsubscribed'
                  WHEN 'email_group_unsubscribe' THEN 'Unsubscribed'
                  WHEN 'sms_link_clicked' THEN 'SMS link clicked'
                  -- BF_SERVER_ATTRIBUTION_ON_TIMELINE_v1 - render the ad click
                  -- readably; the portal shows kind='system' rows as-is.
                  WHEN 'attribution' THEN 'Ad click attribution'
                  ELSE event_type END) AS title,
               (CASE WHEN event_type = 'attribution' THEN
                  NULLIF(concat_ws(' | ',
                    NULLIF('source: ' || COALESCE(payload->>'utm_source',''), 'source: '),
                    NULLIF('medium: ' || COALESCE(payload->>'utm_medium',''), 'medium: '),
                    NULLIF('campaign: ' || COALESCE(payload->>'utm_campaign',''), 'campaign: '),
                    NULLIF('term: ' || COALESCE(payload->>'utm_term',''), 'term: '),
                    NULLIF('ad: ' || COALESCE(payload->>'utm_content',''), 'ad: '),
                    NULLIF('gclid: ' || COALESCE(payload->>'gclid',''), 'gclid: ')
                  ), '')
                ELSE NULLIF(payload->>'url','') END) AS body,
               NULL::text AS extra
          FROM crm_timeline_events
         WHERE contact_id = $1
           AND event_type IN ('sequence_step_sent','email_open','email_click','email_bounce','email_dropped','email_spamreport','email_unsubscribe','email_group_unsubscribe','sms_link_clicked','attribution')
        ORDER BY ts DESC LIMIT 500`
    : `
        SELECT 'note' AS kind, id::text, created_at AS ts,
               NULL::text AS title, body AS body, NULL::text AS extra
          FROM crm_notes WHERE ${col} = $1 AND silo = $2
        UNION ALL
        -- BF_SERVER_RETIRE_CRM_TASKS_v1 - crm_tasks retired; timeline reads unified tasks only.
        -- BF_SERVER_TIMELINE_UNIFIED_TASKS_v1 - the HubSpot-style TaskPopup now
        -- writes to the unified tasks table (via /api/tasks), not crm_tasks.
        -- Without this branch a task created from a contact (BF or BI) never
        -- appeared on that contact's timeline. Same kind/shape so no UI change;
        -- body maps from tasks.body, status from tasks.status. Excludes
        -- soft-deleted rows.
        SELECT 'task' AS kind, id::text, created_at AS ts,
               title, body AS body, status AS extra
          FROM tasks WHERE ${col} = $1 AND silo = $2 AND deleted_at IS NULL
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
        SELECT 'email' AS kind, ('opened-' || e.id::text) AS id, e.opened_at AS ts,
               ('Opened: ' || e.subject ||
                 CASE WHEN oc.n > 1 THEN ' (' || oc.n || ' opens)' ELSE '' END) AS title,
               NULL::text AS body, e.from_address AS extra
          FROM crm_email_log e
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS n FROM email_open_events ev WHERE ev.email_log_id = e.id
          ) oc ON true
         WHERE e.${col} = $1 AND e.silo = $2 AND e.opened_at IS NOT NULL
        UNION ALL
        SELECT 'meeting' AS kind, id::text, created_at AS ts,
               title, attendee_description AS body, location AS extra
          FROM crm_meetings WHERE ${col} = $1 AND silo = $2
        ORDER BY ts DESC LIMIT 500`;

  const { rows } = await pool.query(sql, [id, silo]);
  respondOk(res, rows);
}));

export default router;
