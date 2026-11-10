// BF_SERVER_SEND_QUEUE_v1 - shared marketing send runner. Single source of truth
// for resolving recipients (NO cap) and sending, used both inline (small blasts)
// and by the background send-queue worker (large blasts). Email path here; SMS
// is added in a follow-up. The progress callback lets the worker persist live
// counts as a long blast streams out. Logic mirrors the original inline loop
// exactly (same recipient filter, merge vars, and timeline event).
import type { Pool } from "pg";
import { sendOne, mergeFields } from "./sendgridService.js";
import { renderMarketingSms, sendMarketingSms, trackedLink, lookupLineType } from "./marketingSms.js";
import { isCanadianMobile, SMS_ELIGIBLE_SQL, CAMPAIGN_ELIGIBLE_SQL, CONSENT_SQL } from "./smsConsent.js"; // BF_SERVER_SMS_CONSENT_v1 // BF_SERVER_SEND_QUEUE_SMS_v1 BF_SERVER_BLOCK_v784_LINE_TYPE_IMPORT BF_SERVER_SMS_CASCADE_COMPLETE_v12
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js"; // BF_SERVER_SILENT_QUERIES_v678

// BF_SERVER_EMAIL_AUDIENCE_INCL_EXCL_v1 - include/exclude tag arrays. Include
// empty/null = all contacts; otherwise a contact must carry AT LEAST ONE include
// tag. A contact carrying ANY exclude tag is removed; exclude wins over include.
// Single `tag` kept for back-compat (raw email panel, SMS, Maya tools, old jobs).
// BF_SERVER_EMAIL_TWO_COLUMN_ONLY_v15 - `resend` bypasses the 24h dedupe.
export type EmailJob = { silo: string; tag: string | null; subject: string; html: string; resend?: boolean; tags?: string[] | null; excludeTags?: string[] | null; templateId?: string | null; /** BF_SERVER_v874_MARKETING_TOOLS - the queued job, for the campaign ledger */ jobId?: string | null; /** BF_SERVER_v923_SKIP_TEXTED - leave out anyone sent a marketing text in the last N days */ skipTextedDays?: number | null }; // BF_SERVER_TEMPLATE_ANALYTICS_v1
export type SendProgress = (sent: number, failed: number) => Promise<void>;
// BF_SERVER_SEND_KILL_SWITCH_v1 - worker callback checked between recipient batches.
export type ShouldAbort = () => Promise<boolean>;
export type EmailSendResult = { total: number; sent: number; failed: number; rejectStatus?: number; rejectError?: string; aborted?: boolean }; // BF_SERVER_EMAIL_FAIL_VISIBILITY_v1

// BF_SERVER_v789_EMAIL_BLAST_CONSENT - an email blast reaches only contacts with a live
// CASL consent (CONSENT_SQL: express, implied_transaction < 2 years, implied_inquiry
// < 6 months - the same rule sequences apply via hasSmsConsent) who have not opted out
// of marketing. The count and the send share this predicate.
// BF_SERVER_v910_EMAIL_CONSENT - email marketing consent (email_consent_basis) counts on its own; texting consent
// still counts too. An unsubscribe (marketing_opt_out) always wins.
export const EMAIL_CONSENT_SQL = `(c.email_consent_basis IN ('express', 'marketing_list') OR ${CONSENT_SQL})`;
// BF_SERVER_v917_EMAIL_ALL_CONTACTS - Todd's rule (Nov 9): every CRM contact with an email address gets campaign email.
// Only people who unsubscribed / opted out of marketing are left out. EMAIL_CONSENT_SQL is kept for reports only.
export const EMAIL_BLAST_ELIGIBLE_SQL = `
      COALESCE(c.email,'') <> '' AND COALESCE(c.marketing_opt_out,false) = false`;

// BF_SERVER_v923_SKIP_TEXTED - "Skip contacts who got a marketing text in the last 7 days" on the Email tab.
// true -> 7 days; a number of days (1-90) is also accepted.
export function skipTextedDaysOf(v: unknown): number | null {
  if (v === true || v === "true" || v === "1" || v === 1) return 7;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : null;
}

export async function countEmailRecipients(pool: Pool, silo: string, tag: string | null, tags: string[] | null = null, excludeTags: string[] | null = null, skipTextedDays: number | null = null): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM contacts c
      WHERE c.silo = $1 AND ${EMAIL_BLAST_ELIGIBLE_SQL}
        AND ($2::text IS NULL OR $2 = ANY(c.tags))
        AND ($3::text[] IS NULL OR COALESCE(c.tags,'{}') && $3)
        AND ($4::text[] IS NULL OR NOT (COALESCE(c.tags,'{}') && $4))
        AND ($5::int IS NULL OR NOT EXISTS (
              SELECT 1 FROM sms_campaign_sends x
               WHERE x.contact_id = c.id AND x.message_sid IS NOT NULL
                 AND x.sent_at > now() - ($5::int * interval '1 day')))`,
    [silo, tag, tags, excludeTags, skipTextedDays],
  );
  return r.rows[0]?.n ?? 0;
}

export type EmailRecipient = { id: string; email: string; name: string | null; company: string | null };

/** BF_SERVER_v874_MARKETING_TOOLS - the people an email blast reaches (consent, tags, opt-out); the same predicate as
 *  countEmailRecipients. */
export async function emailRecipients(pool: Pool, job: EmailJob): Promise<EmailRecipient[]> {
  const recips = await pool.query<EmailRecipient>(
    `SELECT c.id, c.email, c.name, co.name AS company
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
      WHERE c.silo = $1 AND ${EMAIL_BLAST_ELIGIBLE_SQL}
        AND ($2::text IS NULL OR $2 = ANY(c.tags))
        AND ($3::text[] IS NULL OR COALESCE(c.tags,'{}') && $3)
        AND ($4::text[] IS NULL OR NOT (COALESCE(c.tags,'{}') && $4))
        AND ($5::int IS NULL OR NOT EXISTS (
              SELECT 1 FROM sms_campaign_sends x
               WHERE x.contact_id = c.id AND x.message_sid IS NOT NULL
                 AND x.sent_at > now() - ($5::int * interval '1 day')))`,
    [job.silo, job.tag, job.tags ?? null, job.excludeTags ?? null, job.skipTextedDays ?? null],
  );
  return recips.rows;
}

export function emailAudienceGiven(job: Pick<EmailJob, "tag" | "tags">): boolean {
  return Boolean(job.tag && job.tag.trim()) || (Array.isArray(job.tags) && job.tags.some((t) => String(t ?? "").trim()));
}

// BF_SERVER_v874_MARKETING_TOOLS - what one campaign email to one person did.
export type OneEmailOutcome = "sent" | "failed" | "skipped";

/**
 * Sends one campaign email. BF_SERVER_v874_MARKETING_TOOLS: when the send belongs to a queued job it is recorded in the
 * campaign ledger (campaign_sends, one row per job and person) so opens, clicks and unsubscribes count for that
 * campaign (the campaign report, the A/B test winner, lead scoring). Honours the 24-hour duplicate guard unless the job
 * asked to resend. No allowance or meter: Boreal's campaigns have no plan limits.
 */
export async function sendCampaignEmailTo(
  pool: Pool,
  job: EmailJob,
  c: EmailRecipient,
  opts: { subject: string; variant?: "A" | "B"; claimedSendId?: string | null },
): Promise<{ outcome: OneEmailOutcome; status?: number; error?: string }> {
  // BF_SERVER_EMAIL_TWO_COLUMN_ONLY_v15 - `resend` skips the 24-hour dedupe.
  // The guard exists so a resumed job cannot double-send, which is right for
  // a real blast; but it also silently swallowed every repeat test send and
  // reported "sent 0 of 0" as though the send had simply produced nothing.
  const alreadySent = job.resend ? { rowCount: 0, rows: [] as { id: string }[] } : await pool.query<{ id: string }>(
    `SELECT id FROM crm_timeline_events
      WHERE contact_id = $1 AND event_type = 'email_marketing_sent'
        AND created_at > now() - interval '24 hours'
        AND payload->>'subject' = $2
      LIMIT 1`,
    [c.id, opts.subject],
  );
  if (alreadySent.rows[0]) {
    if (opts.claimedSendId) await pool.query(`UPDATE campaign_sends SET status = 'skipped' WHERE id = $1`, [opts.claimedSendId]);
    return { outcome: "skipped" };
  }
  const first = (c.name || "").trim().split(/\s+/)[0] || "there";
  const vars = { first_name: first, name: c.name || "there", email: c.email, company: c.company || "" };
  // BF_SERVER_TEMPLATE_ANALYTICS_v1 - ledger row + tse_id custom arg so SendGrid open/click attributes back to the template.
  let __tseId: string | null = null;
  if (job.templateId) {
    try {
      const __t = await pool.query<{ id: string }>(
        `INSERT INTO template_send_events (template_id, contact_id, channel, silo, subject) VALUES ($1,$2,'email',$3,$4) RETURNING id`,
        [job.templateId, c.id, job.silo, opts.subject],
      );
      __tseId = __t.rows[0]?.id ?? null;
    } catch (err) { __tseId = logWarnSwallowed(err, "services/marketingSendRunner.ts:template_send_events", null); }
  }
  // BF_SERVER_v874_MARKETING_TOOLS - the campaign ledger row (one per job and person).
  let csId: string | null = opts.claimedSendId ?? null;
  if (!csId && job.jobId) {
    const cs = await pool.query<{ id: string }>(
      `INSERT INTO campaign_sends (job_id, contact_id, silo, variant, subject, status, sent_at)
       VALUES ($1, $2, $3, $4, $5, 'sent', now())
       ON CONFLICT (job_id, contact_id) DO NOTHING RETURNING id`,
      [job.jobId, c.id, job.silo, opts.variant ?? "A", opts.subject],
    );
    csId = cs.rows[0]?.id ?? null;
    if (!csId) return { outcome: "skipped" }; // already sent in this campaign (a resumed job)
  }
  const customArgs: Record<string, string> = { ...(__tseId ? { tse_id: __tseId } : {}), ...(csId ? { cs_id: csId } : {}) };
  const dropLedgers = async () => {
    if (__tseId) await pool.query(`DELETE FROM template_send_events WHERE id = $1`, [__tseId]).catch((swallowedErr: unknown) => { logWarnSwallowed(swallowedErr, "services/marketingSendRunner.ts:84");});
    if (csId) await pool.query(`UPDATE campaign_sends SET status = 'failed' WHERE id = $1`, [csId]).catch((swallowedErr: unknown) => { logWarnSwallowed(swallowedErr, "services/marketingSendRunner.ts:campaign_sends_failed");});
  };
  try {
    const r = await sendOne({ to: c.email, subject: mergeFields(opts.subject, vars), html: mergeFields(job.html, vars), contactId: c.id, customArgs: Object.keys(customArgs).length ? customArgs : undefined });
    if (r.ok) {
      if (opts.claimedSendId) await pool.query(`UPDATE campaign_sends SET status = 'sent', sent_at = now() WHERE id = $1`, [opts.claimedSendId]);
      await pool.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1,$2,$3)`, [c.id, "email_marketing_sent", JSON.stringify({ subject: opts.subject, tag: job.tag, ...(job.jobId ? { jobId: job.jobId, variant: opts.variant ?? "A" } : {}) })]);
      return { outcome: "sent" };
    }
    await dropLedgers();
    console.error("sendgrid_email_failed", { to: c.email, status: r.status, error: r.error });
    return { outcome: "failed", status: r.status, error: r.error };
  } catch (e) {
    await dropLedgers();
    const error = e instanceof Error ? e.message : String(e);
    console.error("sendgrid_email_exception", { to: c.email, error });
    return { outcome: "failed", error };
  }
}

export async function runEmailSend(pool: Pool, job: EmailJob, onProgress?: SendProgress, shouldAbort?: ShouldAbort): Promise<EmailSendResult> { // BF_SERVER_EMAIL_FAIL_VISIBILITY_v1 BF_SERVER_SEND_KILL_SWITCH_v1
  // BF_SERVER_v932_EMAIL_NO_TAG_ALL - a job with no include tag goes to every contact ("ALL CRM CONTACTS GET EMAILS");
  // excluded tags and opt-outs still apply. Maya's own email action still has to name a tag.
  const rows = await emailRecipients(pool, job);
  let sent = 0, failed = 0, skipped = 0, i = 0;
  let aborted = false; // BF_SERVER_SEND_KILL_SWITCH_v1
  let rejectStatus: number | undefined;
  let rejectError: string | undefined;
  for (const c of rows) {
    const r = await sendCampaignEmailTo(pool, job, c, { subject: job.subject });
    if (r.outcome === "skipped") { skipped++; i++; continue; }
    if (r.outcome === "sent") sent++;
    else {
      failed++;
      if (rejectStatus === undefined) rejectStatus = r.status;
      if (rejectError === undefined) rejectError = r.error;
    }
    i++;
    if (i % 50 === 0) {
      if (onProgress) { try { await onProgress(sent, failed); } catch (err) { logWarnSwallowed(err, "services/marketingSendRunner.ts:progress"); } }
      if (shouldAbort) { try { if (await shouldAbort()) { aborted = true; break; } } catch (err) { logWarnSwallowed(err, "services/marketingSendRunner.ts:abort_check"); } } // BF_SERVER_SEND_KILL_SWITCH_v1
    }
  }
  if (onProgress) { try { await onProgress(sent, failed); } catch (err) { logWarnSwallowed(err, "services/marketingSendRunner.ts:progress_final"); } }
  return { total: rows.length - skipped, sent, failed, rejectStatus, rejectError, aborted };
}


// BF_SERVER_SEND_QUEUE_SMS_v1 - SMS path on the shared runner. Creates the
// sms_campaigns row inside the runner so inline and queued sends behave
// identically (and the 36h cascade worker can find the campaign). Mirrors the
// original inline loop exactly: tracked link, per-send row, opt-out capture, and
// the no-mobile immediate fallback email.
export type SmsJob = { silo: string; tag: string | null; body: string; linkUrl: string | null; fbSubject: string | null; fbHtml: string | null; createdBy: string | null; templateId?: string | null; tags?: string[] | null; excludeTags?: string[] | null; campaignId?: string | null }; // BF_SERVER_TEMPLATE_ANALYTICS_v1 BF_SERVER_SMS_SEND_SAFETY_v710

// BF_SERVER_SMS_SEND_SAFETY_v710
export function phone10(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/[^0-9]/g, "").slice(-10);
}

export type SmsAudienceRow = { id: string; email: string | null; phone: string | null; name: string | null; company: string | null; sms_ok: boolean; marketing_opt_out: boolean; line_type: string | null };
export function planSmsAudience(rows: SmsAudienceRow[], hasFallback: boolean, skipPhones: Set<string> = new Set(), skipEmails: Set<string> = new Set()): { text: SmsAudienceRow[]; email: SmsAudienceRow[] } {
  const seenPhones = new Set(skipPhones);
  const seenEmails = new Set(skipEmails);
  const text: SmsAudienceRow[] = [];
  const email: SmsAudienceRow[] = [];
  for (const r of rows) {
    const p10 = phone10(r.phone);
    const textable = r.sms_ok === true && !r.marketing_opt_out && isCanadianMobile(r.phone) && (r.line_type == null || r.line_type === "mobile") && p10.length === 10;
    if (textable) {
      if (seenPhones.has(p10)) continue;
      seenPhones.add(p10);
      text.push(r);
      continue;
    }
    const emailAddress = String(r.email ?? "").trim().toLowerCase();
    if (hasFallback && emailAddress && !r.marketing_opt_out && !seenEmails.has(emailAddress)) {
      seenEmails.add(emailAddress);
      email.push(r);
    }
  }
  return { text, email };
}

// BF_SERVER_SMS_CONSENT_v1 + BF_SERVER_SMS_AUDIENCE_INCL_EXCL_v1
// The count now matches what actually gets sent: consent-eligible, not opted out of SMS
// OR marketing, mobile, and Canadian. Previously it counted anyone with a phone OR an
// email, so the portal's number bore no relation to the real audience.
// BF_SERVER_SMS_CASCADE_COMPLETE_v12 - `hasFallback` widens the count to match
// the widened send. Without a fallback email the audience is SMS-only and the
// number is unchanged; with one, the count includes the people who will receive
// the email instead, because that is who the campaign actually reaches.
// BF_SERVER_SMS_AUDIENCES_v726 - two audiences on the SMS screen that no CRM tag can
// express, passed as the "tag" so they flow through the count, the queue and the send
// unchanged. Consent, Canada-only, one-per-phone and the 24-hour rule still apply.
//   __aud:started_not_submitted - started an application, never submitted one
//   __aud:cbf_applicants        - past Canadian Business Financing applicants
export const SMS_AUDIENCES: Array<{ tag: string; label: string }> = [
  { tag: "__aud:started_not_submitted", label: "Started, not submitted" },
  { tag: "__aud:cbf_applicants", label: "CBF past applicants" },
];
export const SMS_AUDIENCE_SQL = `(
  $2::text IS NULL
  OR ($2 = '__aud:started_not_submitted' AND 'application_started' = ANY(c.tags)
      AND NOT EXISTS (SELECT 1 FROM applications sa LEFT JOIN application_contacts sac ON sac.application_id = sa.id
                       WHERE sa.submitted_at IS NOT NULL AND (sa.contact_id = c.id OR sac.contact_id = c.id)))
  OR ($2 = '__aud:cbf_applicants' AND c.consent_source = 'CBF application terms')
  OR (left($2, 6) <> '__aud:' AND $2 = ANY(c.tags))
)`;

export async function countSmsRecipients(pool: Pool, silo: string, tag: string | null, tags?: string[] | null, excludeTags?: string[] | null, hasFallback = false): Promise<number> {
  const r = await pool.query<SmsAudienceRow>(
    `SELECT c.id, c.email, c.phone, c.name, NULL::text AS company, (${SMS_ELIGIBLE_SQL}) AS sms_ok,
            COALESCE(c.marketing_opt_out,false) AS marketing_opt_out, c.line_type
       FROM contacts c
      WHERE c.silo = $1
        AND ${SMS_AUDIENCE_SQL}
        AND ($3::text[] IS NULL OR c.tags && $3::text[])
        AND ($4::text[] IS NULL OR NOT (c.tags && $4::text[]))
        AND ${hasFallback ? CAMPAIGN_ELIGIBLE_SQL : SMS_ELIGIBLE_SQL}
      ORDER BY c.created_at ASC, c.id ASC`,
    [silo, tag, tags ?? null, excludeTags ?? null],
  );
  const plan = planSmsAudience(r.rows, hasFallback, await recentlyTextedPhones(pool));
  return plan.text.length + plan.email.length;
}

async function recentlyTextedPhones(pool: Pool): Promise<Set<string>> {
  const r = await pool.query<{ p10: string }>(
    `SELECT DISTINCT right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'),10) AS p10
       FROM sms_campaign_sends
      WHERE message_sid IS NOT NULL AND sent_at > now() - interval '24 hours'`,
  );
  return new Set(r.rows.map((x) => x.p10).filter((x) => x.length === 10));
}

export async function runSmsSend(pool: Pool, job: SmsJob, onProgress?: SendProgress, shouldAbort?: ShouldAbort, onCampaign?: (campaignId: string) => Promise<void>): Promise<{ total: number; smsSent: number; emailSent: number; failed: number; campaignId: string; aborted?: boolean }> { // BF_SERVER_SEND_KILL_SWITCH_v1
  let campaignId = job.campaignId ?? null;
  if (!campaignId) {
    const cam = await pool.query<{ id: string }>(
      `INSERT INTO sms_campaigns (silo, tag, sms_body, link_url, fallback_subject, fallback_html, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [job.silo, job.tag, job.body, job.linkUrl, job.fbSubject, job.fbHtml, job.createdBy],
    );
    campaignId = cam.rows[0].id;
    if (onCampaign) await onCampaign(campaignId);
  }
  const done = await pool.query<{ p10: string; email: string | null }>(
    `SELECT right(regexp_replace(coalesce(s.phone,''),'[^0-9]','','g'),10) AS p10, lower(c.email) AS email
       FROM sms_campaign_sends s LEFT JOIN contacts c ON c.id = s.contact_id
      WHERE s.campaign_id = $1`, [campaignId],
  );
  const skipPhones = await recentlyTextedPhones(pool);
  const skipEmails = new Set<string>();
  for (const sent of done.rows) {
    if (sent.p10?.length === 10) skipPhones.add(sent.p10);
    if (sent.email) skipEmails.add(sent.email);
  }
  const recips = await pool.query<SmsAudienceRow>(
    `SELECT c.id, c.email, c.phone, c.name, co.name AS company, (${SMS_ELIGIBLE_SQL}) AS sms_ok,
            COALESCE(c.marketing_opt_out,false) AS marketing_opt_out, c.line_type
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
      WHERE c.silo = $1
        AND ${SMS_AUDIENCE_SQL}
        AND ($3::text[] IS NULL OR c.tags && $3::text[])
        AND ($4::text[] IS NULL OR NOT (c.tags && $4::text[]))
        AND ${job.fbHtml ? CAMPAIGN_ELIGIBLE_SQL : SMS_ELIGIBLE_SQL}
      ORDER BY c.created_at ASC, c.id ASC`,
    [job.silo, job.tag, job.tags ?? null, job.excludeTags ?? null],
  );
  const plan = planSmsAudience(recips.rows, Boolean(job.fbHtml), skipPhones, skipEmails);
  const ordered = [...plan.text.map((c) => ({ c, mode: "text" as const })), ...plan.email.map((c) => ({ c, mode: "email" as const }))];
  let smsSent = 0, emailSent = 0, failed = 0, i = 0;
  let aborted = false; // BF_SERVER_SEND_KILL_SWITCH_v1
  for (const { c, mode } of ordered) {
    const first = (c.name || "").trim().split(/\s+/)[0] || "there";
    const vars = { first_name: first, name: c.name || "there", email: c.email || "", company: c.company || "" };
    // BF_SERVER_BLOCK_v784_LINE_TYPE_LOOP - lazily verify line type; skip non-mobile, cache result.
    // BF_SERVER_SMS_CONSENT_v1 - marketing_opt_out was NEVER checked here (only the email
    // fallback below honoured it), so a contact who opted out of all marketing still got
    // texted. Canada-only: nothing in this path ever looked at country.
    let hasPhone = mode === "text";
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
      const text = renderMarketingSms({
        body: job.body,
        vars,
        link: job.linkUrl ? trackedLink(sendId, job.linkUrl) : null,
      });
      const r = await sendMarketingSms(String(c.phone), text);
      if (r.ok) {
        smsSent++;
        await pool.query(`UPDATE sms_campaign_sends SET message_sid = $2, delivery_status = 'queued' WHERE id = $1`, [sendId, r.sid ?? null]);
        await pool.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1,$2,$3)`, [c.id, "sms_marketing_sent", JSON.stringify({ campaignId })]);
        // BF_SERVER_TEMPLATE_ANALYTICS_v1 - SMS send ledger (sends + replies; SMS click tracking is a follow-up).
        if (job.templateId) { try { await pool.query(`INSERT INTO template_send_events (template_id, contact_id, channel, silo) VALUES ($1,$2,'sms',$3)`, [job.templateId, c.id, job.silo]); } catch { /* ledger best-effort */ } }
      } else {
        // BF_SERVER_SMS_CASCADE_COMPLETE_v12 - a Twilio rejection used to be
        // counted and forgotten. The 36h cascade worker only revisits rows in
        // sms_campaign_sends that were actually sent, so a failed send meant
        // the contact heard nothing at all. Fall through to the email instead,
        // and drop the useless send row so the worker does not later chase it.
        failed++;
        if (r.optedOut) await pool.query(`UPDATE contacts SET sms_opt_out = true, updated_at = now() WHERE id = $1`, [c.id]);
        await pool.query(`DELETE FROM sms_campaign_sends WHERE id = $1`, [sendId]).catch((swallowedErr: unknown) => { logWarnSwallowed(swallowedErr, "services/marketingSendRunner.ts:193");});
        if (c.email && !c.marketing_opt_out && job.fbHtml) {
          const fb = await sendOne({ to: c.email, subject: mergeFields(job.fbSubject || "Following up", vars), html: mergeFields(job.fbHtml, vars), contactId: c.id });
          if (fb.ok) {
            emailSent++;
            failed--;
            await pool.query(`INSERT INTO sms_campaign_sends (campaign_id, contact_id, silo, fallback_sent, fallback_at) VALUES ($1,$2,$3,true,now())`, [campaignId, c.id, job.silo]);
            await pool.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1,$2,$3)`, [c.id, "email_cascade_sent", JSON.stringify({ campaignId, reason: "sms_send_failed" })]);
          }
        }
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
    if (i % 50 === 0) {
      if (onProgress) { try { await onProgress(smsSent + emailSent, failed); } catch { /* best-effort */ } }
      if (shouldAbort) { try { if (await shouldAbort()) { aborted = true; break; } } catch { /* keep sending */ } } // BF_SERVER_SEND_KILL_SWITCH_v1
    }
  }
  if (onProgress) { try { await onProgress(smsSent + emailSent, failed); } catch { /* best-effort */ } }
  return { total: ordered.length, smsSent, emailSent, failed, campaignId, aborted };
}
