// BF_SERVER_BLOCK_v797_EMAIL_OPEN_TRACKING — if a staff-sent 1:1 email is not opened
// within 24 BUSINESS hours (Mon–Fri; weekend time is not counted), notify the sender in
// the Notification Centre so they can follow up instead of wondering if it arrived.
// Open detection is the tracking pixel (and the v706 "Read:" receipt) stamping opened_at.
// Candidates older than 30 days are ignored, and followup_notified_at is set once so a
// sender is alerted at most once per email. Note: weekday boundaries are computed in UTC,
// which can shift the weekend cutoff by a few hours vs Mountain Time — acceptable for a
// next-business-day nudge.
import type { Pool } from "pg";

const TICK_MS = 30 * 60_000;

function businessHoursBetween(start: Date, end: Date): number {
  if (!(end > start)) return 0;
  let hours = 0;
  const cur = new Date(start.getTime());
  for (let i = 0; i < 24 * 45 && cur < end; i++) {
    const day = cur.getUTCDay(); // 0=Sun … 6=Sat
    if (day >= 1 && day <= 5) hours += 1;
    cur.setUTCHours(cur.getUTCHours() + 1);
  }
  return hours;
}

export function startEmailFollowupWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const { rows } = await pool.query<{
        id: string; owner_id: string; subject: string | null;
        to_addresses: string[] | null; contact_id: string | null; created_at: string;
      }>(
        `SELECT id, owner_id, subject, to_addresses, contact_id, created_at
           FROM crm_email_log
          WHERE opened_at IS NULL
            AND followup_notified_at IS NULL
            AND owner_id IS NOT NULL
            AND created_at < now() - interval '24 hours'
            AND created_at > now() - interval '30 days'
          ORDER BY created_at ASC
          LIMIT 200`,
      );
      const now = new Date();
      for (const r of rows) {
        try {
          const sent = new Date(r.created_at);
          if (businessHoursBetween(sent, now) < 24) continue;
          const recipient = Array.isArray(r.to_addresses)
            ? (r.to_addresses[0] ?? "")
            : String(r.to_addresses ?? "");
          const subject = r.subject || "(no subject)";
          const body = `No open after 24h: "${subject}"${recipient ? ` to ${recipient}` : ""}. Consider following up.`;
          const contextUrl = r.contact_id ? `/crm/contacts/${r.contact_id}` : "/communications";
          await pool.query(
            `INSERT INTO notifications (user_id, type, ref_table, ref_id, body, context_url)
             VALUES ($1, 'email_unopened', 'crm_email_log', $2, $3, $4)
             ON CONFLICT ON CONSTRAINT notifications_unique_per_ref DO NOTHING`,
            [String(r.owner_id), String(r.id), body, contextUrl],
          );
          await pool.query(
            `UPDATE crm_email_log SET followup_notified_at = now() WHERE id = $1`,
            [r.id],
          );
        } catch (err) {
          console.error("[emailFollowupWorker] notify failed:", err);
        }
      }
    } catch (err) {
      console.error("[emailFollowupWorker] tick failed:", err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, TICK_MS);
  setTimeout(() => { void tick(); }, 60_000);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
