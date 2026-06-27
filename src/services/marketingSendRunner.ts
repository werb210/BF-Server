// BF_SERVER_SEND_QUEUE_v1 - shared marketing send runner. Single source of truth
// for resolving recipients (NO cap) and sending, used both inline (small blasts)
// and by the background send-queue worker (large blasts). Email path here; SMS
// is added in a follow-up. The progress callback lets the worker persist live
// counts as a long blast streams out. Logic mirrors the original inline loop
// exactly (same recipient filter, merge vars, and timeline event).
import type { Pool } from "pg";
import { sendOne, mergeFields } from "./sendgridService.js";

export type EmailJob = { silo: string; tag: string | null; subject: string; html: string };
export type SendProgress = (sent: number, failed: number) => Promise<void>;

export async function countEmailRecipients(pool: Pool, silo: string, tag: string | null): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM contacts c
      WHERE c.silo = $1 AND COALESCE(c.email,'') <> '' AND COALESCE(c.marketing_opt_out,false) = false
        AND ($2::text IS NULL OR $2 = ANY(c.tags))`,
    [silo, tag],
  );
  return r.rows[0]?.n ?? 0;
}

export async function runEmailSend(pool: Pool, job: EmailJob, onProgress?: SendProgress): Promise<{ total: number; sent: number; failed: number }> {
  const recips = await pool.query<{ id: string; email: string; name: string | null; company: string | null }>(
    `SELECT c.id, c.email, c.name, co.name AS company
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
      WHERE c.silo = $1 AND COALESCE(c.email,'') <> '' AND COALESCE(c.marketing_opt_out,false) = false
        AND ($2::text IS NULL OR $2 = ANY(c.tags))`,
    [job.silo, job.tag],
  );
  let sent = 0, failed = 0, i = 0;
  for (const c of recips.rows) {
    const first = (c.name || "").trim().split(/\s+/)[0] || "there";
    const vars = { first_name: first, name: c.name || "there", email: c.email, company: c.company || "" };
    try {
      const r = await sendOne({ to: c.email, subject: mergeFields(job.subject, vars), html: mergeFields(job.html, vars), contactId: c.id });
      if (r.ok) {
        sent++;
        await pool.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1,$2,$3)`, [c.id, "email_marketing_sent", JSON.stringify({ subject: job.subject, tag: job.tag })]);
      } else { failed++; }
    } catch { failed++; }
    i++;
    if (onProgress && i % 50 === 0) { try { await onProgress(sent, failed); } catch { /* progress best-effort */ } }
  }
  if (onProgress) { try { await onProgress(sent, failed); } catch { /* best-effort */ } }
  return { total: recips.rows.length, sent, failed };
}
