// BF_SERVER_SMS_CASCADE_WORKER_v1 - 36h after a marketing SMS, if the recipient
// did not click the tracked link and did not reply, send the fallback marketing
// email (SendGrid). Reply = any inbound message after the SMS was sent.
import type { Pool } from "pg";
import { sendOne, mergeFields } from "../services/sendgridService.js";

const TICK_MS = 5 * 60_000;

export function startSmsCascadeWorker(pool: Pool): { stop: () => void } {
  let stopped = false, running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const { rows } = await pool.query<{ id: string; contact_id: string; email: string; name: string | null; company: string | null; fallback_subject: string | null; fallback_html: string }>(
        `SELECT s.id, s.contact_id, c.email, c.name, co.name AS company, cam.fallback_subject, cam.fallback_html
           FROM sms_campaign_sends s
           JOIN sms_campaigns cam ON cam.id = s.campaign_id
           JOIN contacts c ON c.id = s.contact_id
           LEFT JOIN companies co ON co.id = c.company_id
          WHERE s.fallback_sent = false
            AND s.clicked_at IS NULL
            AND s.sent_at <= now() - interval '36 hours'
            AND COALESCE(cam.fallback_html,'') <> ''
            AND COALESCE(c.email,'') <> '' AND COALESCE(c.marketing_opt_out,false) = false
            AND NOT EXISTS (
              SELECT 1 FROM communications_messages m
               WHERE m.contact_id = s.contact_id AND m.direction = 'inbound' AND m.created_at > s.sent_at
            )
          ORDER BY s.sent_at ASC
          LIMIT 20`,
      );
      for (const r of rows) {
        const first = (r.name || "").trim().split(/\s+/)[0] || "there";
        const vars = { first_name: first, name: r.name || "there", email: r.email, company: r.company || "" };
        try {
          const res = await sendOne({ to: r.email, subject: mergeFields(r.fallback_subject || "Following up", vars), html: mergeFields(r.fallback_html, vars), contactId: r.contact_id });
          await pool.query(`UPDATE sms_campaign_sends SET fallback_sent = true, fallback_at = now() WHERE id = $1`, [r.id]);
          if (res.ok) await pool.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1,$2,$3)`, [r.contact_id, "email_cascade_sent", JSON.stringify({})]);
        } catch { /* leave for next tick */ }
      }
    } catch { /* never crash the app */ } finally { running = false; }
  };
  const h = setInterval(tick, TICK_MS);
  setTimeout(tick, 15_000);
  return { stop: () => { stopped = true; clearInterval(h); } };
}
