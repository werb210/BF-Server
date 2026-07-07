// BF_SERVER_SEND_QUEUE_v1 - shared marketing send runner. Single source of truth
// for resolving recipients (NO cap) and sending, used both inline (small blasts)
// and by the background send-queue worker (large blasts). Email path here; SMS
// is added in a follow-up. The progress callback lets the worker persist live
// counts as a long blast streams out. Logic mirrors the original inline loop
// exactly (same recipient filter, merge vars, and timeline event).
import type { Pool } from "pg";
import { sendOne, mergeFields } from "./sendgridService.js";
import { sendMarketingSms, trackedLink, lookupLineType } from "./marketingSms.js"; // BF_SERVER_SEND_QUEUE_SMS_v1 BF_SERVER_BLOCK_v784_LINE_TYPE_IMPORT

// BF_SERVER_EMAIL_AUDIENCE_INCL_EXCL_v1 - include/exclude tag arrays. Include
// empty/null = all contacts; otherwise a contact must carry AT LEAST ONE include
// tag. A contact carrying ANY exclude tag is removed; exclude wins over include.
// Single `tag` kept for back-compat (raw email panel, SMS, Maya tools, old jobs).
export type EmailJob = { silo: string; tag: string | null; subject: string; html: string; tags?: string[] | null; excludeTags?: string[] | null; templateId?: string | null }; // BF_SERVER_TEMPLATE_ANALYTICS_v1
export type SendProgress = (sent: number, failed: number) => Promise<void>;
export type EmailSendResult = { total: number; sent: number; failed: number; rejectStatus?: number; rejectError?: string }; // BF_SERVER_EMAIL_FAIL_VISIBILITY_v1

export async function countEmailRecipients(pool: Pool, silo: string, tag: string | null, tags: string[] | null = null, excludeTags: string[] | null = null): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM contacts c
      WHERE c.silo = $1 AND COALESCE(c.email,'') <> '' AND COALESCE(c.marketing_opt_out,false) = false
        AND ($2::text IS NULL OR $2 = ANY(c.tags))
        AND ($3::text[] IS NULL OR COALESCE(c.tags,'{}') && $3)
        AND ($4::text[] IS NULL OR NOT (COALESCE(c.tags,'{}') && $4))`,
    [silo, tag, tags, excludeTags],
  );
  return r.rows[0]?.n ?? 0;
}

export async function runEmailSend(pool: Pool, job: EmailJob, onProgress?: SendProgress): Promise<EmailSendResult> { // BF_SERVER_EMAIL_FAIL_VISIBILITY_v1
  const recips = await pool.query<{ id: string; email: string; name: string | null; company: string | null }>(
    `SELECT c.id, c.email, c.name, co.name AS company
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
      WHERE c.silo = $1 AND COALESCE(c.email,'') <> '' AND COALESCE(c.marketing_opt_out,false) = false
        AND ($2::text IS NULL OR $2 = ANY(c.tags))
        AND ($3::text[] IS NULL OR COALESCE(c.tags,'{}') && $3)
        AND ($4::text[] IS NULL OR NOT (COALESCE(c.tags,'{}') && $4))`,
    [job.silo, job.tag, job.tags ?? null, job.excludeTags ?? null],
  );
  let sent = 0, failed = 0, skipped = 0, i = 0;
  let rejectStatus: number | undefined;
  let rejectError: string | undefined;
  for (const c of recips.rows) {
    const alreadySent = await pool.query<{ id: string }>(
      `SELECT id FROM crm_timeline_events
        WHERE contact_id = $1 AND event_type = 'email_marketing_sent'
          AND created_at > now() - interval '24 hours'
          AND payload->>'subject' = $2
        LIMIT 1`,
      [c.id, job.subject],
    );
    if (alreadySent.rows[0]) { skipped++; i++; continue; }
    const first = (c.name || "").trim().split(/\s+/)[0] || "there";
    const vars = { first_name: first, name: c.name || "there", email: c.email, company: c.company || "" };
    // BF_SERVER_TEMPLATE_ANALYTICS_v1 - ledger row + tse_id custom arg so SendGrid open/click attributes back to the template.
    let __tseId: string | null = null;
    if (job.templateId) {
      try {
        const __t = await pool.query<{ id: string }>(
          `INSERT INTO template_send_events (template_id, contact_id, channel, silo, subject) VALUES ($1,$2,'email',$3,$4) RETURNING id`,
          [job.templateId, c.id, job.silo, job.subject],
        );
        __tseId = __t.rows[0]?.id ?? null;
      } catch { __tseId = null; }
    }
    try {
      const r = await sendOne({ to: c.email, subject: mergeFields(job.subject, vars), html: mergeFields(job.html, vars), contactId: c.id, customArgs: __tseId ? { tse_id: __tseId } : undefined });
      if (r.ok) {
        sent++;
        await pool.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1,$2,$3)`, [c.id, "email_marketing_sent", JSON.stringify({ subject: job.subject, tag: job.tag })]);
      } else {
        failed++;
        if (__tseId) await pool.query(`DELETE FROM template_send_events WHERE id = $1`, [__tseId]).catch(() => {});
        if (rejectStatus === undefined) rejectStatus = r.status;
        if (rejectError === undefined) rejectError = r.error;
        console.error("sendgrid_email_failed", { to: c.email, status: r.status, error: r.error });
      }
    } catch (e) { failed++; if (__tseId) await pool.query(`DELETE FROM template_send_events WHERE id = $1`, [__tseId]).catch(() => {}); if (rejectError === undefined) rejectError = e instanceof Error ? e.message : String(e); console.error("sendgrid_email_exception", { to: c.email, error: e instanceof Error ? e.message : String(e) }); }
    i++;
    if (onProgress && i % 50 === 0) { try { await onProgress(sent, failed); } catch { /* progress best-effort */ } }
  }
  if (onProgress) { try { await onProgress(sent, failed); } catch { /* best-effort */ } }
  return { total: recips.rows.length - skipped, sent, failed, rejectStatus, rejectError };
}


// BF_SERVER_SEND_QUEUE_SMS_v1 - SMS path on the shared runner. Creates the
// sms_campaigns row inside the runner so inline and queued sends behave
// identically (and the 36h cascade worker can find the campaign). Mirrors the
// original inline loop exactly: tracked link, per-send row, opt-out capture, and
// the no-mobile immediate fallback email.
export type SmsJob = { silo: string; tag: string | null; body: string; linkUrl: string | null; fbSubject: string | null; fbHtml: string | null; createdBy: string | null; templateId?: string | null }; // BF_SERVER_TEMPLATE_ANALYTICS_v1

export async function countSmsRecipients(pool: Pool, silo: string, tag: string | null): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM contacts c
      WHERE c.silo = $1 AND ($2::text IS NULL OR $2 = ANY(c.tags))
        AND ( (COALESCE(c.phone,'') <> '' AND (c.line_type IS NULL OR c.line_type = 'mobile')) OR COALESCE(c.email,'') <> '' )`,
    [silo, tag],
  );
  return r.rows[0]?.n ?? 0;
}

export async function runSmsSend(pool: Pool, job: SmsJob, onProgress?: SendProgress): Promise<{ total: number; smsSent: number; emailSent: number; failed: number; campaignId: string }> {
  const cam = await pool.query<{ id: string }>(
    `INSERT INTO sms_campaigns (silo, tag, sms_body, link_url, fallback_subject, fallback_html, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [job.silo, job.tag, job.body, job.linkUrl, job.fbSubject, job.fbHtml, job.createdBy],
  );
  const campaignId = cam.rows[0].id;
  const recips = await pool.query<{ id: string; email: string | null; phone: string | null; name: string | null; company: string | null; sms_opt_out: boolean; marketing_opt_out: boolean; line_type: string | null }>(
    `SELECT c.id, c.email, c.phone, c.name, co.name AS company, COALESCE(c.sms_opt_out,false) AS sms_opt_out, COALESCE(c.marketing_opt_out,false) AS marketing_opt_out, c.line_type
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
      WHERE c.silo = $1 AND ($2::text IS NULL OR $2 = ANY(c.tags))
        AND (COALESCE(c.phone,'') <> '' OR COALESCE(c.email,'') <> '')`,
    [job.silo, job.tag],
  );
  let smsSent = 0, emailSent = 0, failed = 0, i = 0;
  for (const c of recips.rows) {
    const first = (c.name || "").trim().split(/\s+/)[0] || "there";
    const vars = { first_name: first, name: c.name || "there", email: c.email || "", company: c.company || "" };
    // BF_SERVER_BLOCK_v784_LINE_TYPE_LOOP - lazily verify line type; skip non-mobile, cache result.
    let hasPhone = Boolean(c.phone) && !c.sms_opt_out;
    if (hasPhone && c.line_type == null) {
      const lt = await lookupLineType(String(c.phone));
      if (lt) await pool.query(`UPDATE contacts SET line_type = $2, line_type_checked_at = now() WHERE id = $1`, [c.id, lt]);
      if (lt && lt !== "mobile") hasPhone = false;
    } else if (hasPhone && c.line_type && c.line_type !== "mobile") {
      hasPhone = false;
    }
    if (hasPhone) {
      const send = await pool.query<{ id: string }>(`INSERT INTO sms_campaign_sends (campaign_id, contact_id, silo, phone) VALUES ($1,$2,$3,$4) RETURNING id`, [campaignId, c.id, job.silo, c.phone]);
      const sendId = send.rows[0].id;
      // BF_SERVER_SMS_CASL_FOOTER_v1 - CASL identification + opt-out on every marketing SMS.
      const baseText = job.linkUrl ? `${job.body} ${trackedLink(sendId, job.linkUrl)}` : job.body;
      const text = `${baseText} Reply STOP to opt out. Info: boreal.financial/sms`;
      const r = await sendMarketingSms(String(c.phone), text);
      if (r.ok) {
        smsSent++;
        await pool.query(`UPDATE sms_campaign_sends SET message_sid = $2, delivery_status = 'queued' WHERE id = $1`, [sendId, r.sid ?? null]);
        await pool.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1,$2,$3)`, [c.id, "sms_marketing_sent", JSON.stringify({ campaignId })]);
        // BF_SERVER_TEMPLATE_ANALYTICS_v1 - SMS send ledger (sends + replies; SMS click tracking is a follow-up).
        if (job.templateId) { try { await pool.query(`INSERT INTO template_send_events (template_id, contact_id, channel, silo) VALUES ($1,$2,'sms',$3)`, [job.templateId, c.id, job.silo]); } catch { /* ledger best-effort */ } }
      } else {
        failed++;
        if (r.optedOut) await pool.query(`UPDATE contacts SET sms_opt_out = true, updated_at = now() WHERE id = $1`, [c.id]);
      }
    } else if (c.email && !c.marketing_opt_out && job.fbHtml) {
      const r = await sendOne({ to: c.email, subject: mergeFields(job.fbSubject || "Following up", vars), html: mergeFields(job.fbHtml, vars), contactId: c.id });
      if (r.ok) {
        emailSent++;
        await pool.query(`INSERT INTO sms_campaign_sends (campaign_id, contact_id, silo, fallback_sent, fallback_at) VALUES ($1,$2,$3,true,now())`, [campaignId, c.id, job.silo]);
        await pool.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1,$2,$3)`, [c.id, "email_cascade_sent", JSON.stringify({ campaignId, reason: "no_mobile" })]);
      } else { failed++; }
    }
    i++;
    if (onProgress && i % 50 === 0) { try { await onProgress(smsSent + emailSent, failed); } catch { /* best-effort */ } }
  }
  if (onProgress) { try { await onProgress(smsSent + emailSent, failed); } catch { /* best-effort */ } }
  return { total: recips.rows.length, smsSent, emailSent, failed, campaignId };
}
