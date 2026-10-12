// BF_SERVER_SMS_CASCADE_WORKER_v1 - 36h after a marketing SMS, if the recipient
// did not click the tracked link and did not reply, send the fallback marketing
// email (SendGrid). Reply = any inbound message after the SMS was sent.
import type { Pool } from "pg";
import { sendOne, mergeFields } from "../services/sendgridService.js";
import { withWorkerLock } from "./claim.js"; // BF_SERVER_v789_WORKER_CLAIM

const TICK_MS = 5 * 60_000;
// BF_SERVER_v789_SMS_CASCADE_ATTEMPTS - give up on a row after this many failed sends.
export const SMS_CASCADE_MAX_ATTEMPTS = 5;

function errMessage(err: unknown): string {
  return (err as { message?: string } | null)?.message ?? String(err);
}

// BF_SERVER_v789_SMS_CASCADE_SENT_ONLY_ON_SUCCESS - fallback_sent used to be set
// whether or not SendGrid accepted the email, so a failed send was recorded as
// sent and never retried. Now: only a successful send sets fallback_sent; a
// failure bumps fallback_attempts (and is retried next tick until the cap).
export async function runSmsCascadeOnce(pool: Pool): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0;
  const { rows } = await pool.query<{ id: string; contact_id: string; email: string; name: string | null; company: string | null; fallback_subject: string | null; fallback_html: string }>(
    `SELECT s.id, s.contact_id, c.email, c.name, co.name AS company, cam.fallback_subject, cam.fallback_html
       FROM sms_campaign_sends s
       JOIN sms_campaigns cam ON cam.id = s.campaign_id
       JOIN contacts c ON c.id = s.contact_id
       LEFT JOIN companies co ON co.id = c.company_id
      WHERE s.fallback_sent = false
        AND s.clicked_at IS NULL
        AND s.sent_at <= now() - interval '36 hours'
        AND COALESCE(s.fallback_attempts, 0) < $1
        AND COALESCE(cam.fallback_html,'') <> ''
        AND COALESCE(c.email,'') <> '' AND COALESCE(c.marketing_opt_out,false) = false
        AND NOT EXISTS (
          SELECT 1 FROM communications_messages m
           WHERE m.contact_id = s.contact_id AND m.direction = 'inbound' AND m.created_at > s.sent_at
        )
      ORDER BY s.sent_at ASC
      LIMIT 20`,
    [SMS_CASCADE_MAX_ATTEMPTS],
  );
  for (const r of rows) {
    const first = (r.name || "").trim().split(/\s+/)[0] || "there";
    const vars = { first_name: first, name: r.name || "there", email: r.email, company: r.company || "" };
    let res: { ok: boolean; status: number; error?: string };
    try {
      res = await sendOne({ to: r.email, subject: mergeFields(r.fallback_subject || "Following up", vars), html: mergeFields(r.fallback_html, vars), contactId: r.contact_id });
    } catch (err) {
      res = { ok: false, status: 0, error: errMessage(err) };
    }
    if (!res.ok) {
      failed += 1;
      console.warn("[sms-cascade] fallback email failed; will retry", { sendId: r.id, status: res.status, error: res.error });
      try {
        await pool.query(
          `UPDATE sms_campaign_sends SET fallback_attempts = COALESCE(fallback_attempts, 0) + 1, fallback_error = $2 WHERE id = $1`,
          [r.id, `${res.status}: ${String(res.error ?? "").slice(0, 300)}`],
        );
      } catch (err) {
        console.error("[sms-cascade] could not record the failed attempt", { sendId: r.id, message: errMessage(err) });
      }
      continue;
    }
    sent += 1;
    try {
      await pool.query(`UPDATE sms_campaign_sends SET fallback_sent = true, fallback_at = now(), fallback_error = NULL WHERE id = $1`, [r.id]);
    } catch (err) {
      // The email went out but is not recorded: the next tick may send it again. Loud on purpose.
      console.error("[sms-cascade] fallback email SENT but not recorded", { sendId: r.id, message: errMessage(err) });
      continue;
    }
    try {
      await pool.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1,$2,$3)`, [r.contact_id, "email_cascade_sent", JSON.stringify({})]);
    } catch (err) {
      console.warn("[sms-cascade] timeline event insert failed", { sendId: r.id, message: errMessage(err) });
    }
  }
  return { sent, failed };
}

export function startSmsCascadeWorker(pool: Pool): { stop: () => void } {
  let stopped = false, running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      // BF_SERVER_v789_WORKER_CLAIM - one instance per tick.
      const out = await withWorkerLock("sms_cascade", () => runSmsCascadeOnce(pool));
      if (out.ran && (out.result.sent || out.result.failed)) console.log("[sms-cascade] tick", JSON.stringify(out.result));
    } catch (err) {
      console.error("[sms-cascade] tick failed", { message: errMessage(err) });
    } finally { running = false; }
  };
  const h = setInterval(() => { void tick(); }, TICK_MS);
  const first = setTimeout(() => { void tick(); }, 15_000);
  return { stop: () => { stopped = true; clearInterval(h); clearTimeout(first); } };
}
