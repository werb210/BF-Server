// BF_SERVER_v874_MARKETING_TOOLS - the campaign and funded-deal report (ported from KS-server #48 without the Marketing
// add-on gate: every Boreal marketer gets the whole report). Mounted inside the marketing router, so it needs marketing
// access and answers for the request's silo only (BF, BI or SLF).
//   GET /api/marketing/campaign-report?days=90
// Per email and text campaign: how many it was sent to, opened, clicked and unsubscribed (email), and sent and clicked
// (text); plus the applications started and the deals funded by the people it reached within 90 days of the send, and
// the amount funded. A person reached by two campaigns counts for both. Email campaigns sent before the campaign ledger
// existed only know how many were sent.
import { Router } from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";

const router = Router();

export const ATTRIBUTION_DAYS = 90;
const FUNDED = `(a.funded_at IS NOT NULL OR a.pipeline_state = 'Funded')`;

export const EMAIL_CAMPAIGNS_SQL = `SELECT j.id::text AS id, j.status, j.created_at, j.finished_at, j.total, j.sent AS job_sent,
       j.payload->>'subject' AS subject, j.payload->'ab' AS ab, j.payload->>'sendTime' AS send_time,
       COUNT(cs.id) FILTER (WHERE cs.status = 'sent')::int AS sent,
       COUNT(cs.opened_at)::int AS opened, COUNT(cs.clicked_at)::int AS clicked,
       COUNT(cs.unsubscribed_at)::int AS unsubscribed, COUNT(cs.id)::int AS ledger
  FROM marketing_send_jobs j LEFT JOIN campaign_sends cs ON cs.job_id = j.id
 WHERE j.silo = $1 AND j.channel = 'email' AND j.created_at >= now() - ($2::int * interval '1 day')
 GROUP BY j.id ORDER BY j.created_at DESC LIMIT 100`;

export const SMS_CAMPAIGNS_SQL = `SELECT j.id::text AS id, j.status, j.created_at, j.finished_at, j.total, j.sent AS job_sent,
       j.payload->>'body' AS body, j.payload->>'campaignId' AS campaign_id,
       COALESCE(s.sent, 0) AS sent, COALESCE(s.clicked, 0) AS clicked, COALESCE(s.fallback_emails, 0) AS fallback_emails
  FROM marketing_send_jobs j
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE x.message_sid IS NOT NULL)::int AS sent, COUNT(x.clicked_at)::int AS clicked,
           COUNT(*) FILTER (WHERE x.fallback_sent)::int AS fallback_emails
      FROM sms_campaign_sends x WHERE x.campaign_id::text = j.payload->>'campaignId'
  ) s ON true
 WHERE j.silo = $1 AND j.channel = 'sms' AND j.created_at >= now() - ($2::int * interval '1 day')
 ORDER BY j.created_at DESC LIMIT 100`;

export const EMAIL_FUNDED_SQL = `WITH hits AS (
  SELECT DISTINCT cs.job_id, a.id, a.funded_at, a.pipeline_state, COALESCE(a.funded_amount, 0) AS funded_amount
    FROM campaign_sends cs
    JOIN applications a ON a.contact_id = cs.contact_id
     AND COALESCE(a.silo, 'BF') = cs.silo
     AND a.created_at >= cs.sent_at AND a.created_at < cs.sent_at + interval '${ATTRIBUTION_DAYS} days'
   WHERE cs.job_id::text = ANY($1::text[]) AND cs.status = 'sent')
SELECT a.job_id::text AS id, COUNT(*)::int AS applications, COUNT(*) FILTER (WHERE ${FUNDED})::int AS funded,
       COALESCE(SUM(a.funded_amount) FILTER (WHERE ${FUNDED}), 0)::float AS funded_amount
  FROM hits a GROUP BY a.job_id`;

export const SMS_FUNDED_SQL = `WITH hits AS (
  SELECT DISTINCT x.campaign_id, a.id, a.funded_at, a.pipeline_state, COALESCE(a.funded_amount, 0) AS funded_amount
    FROM sms_campaign_sends x
    JOIN applications a ON a.contact_id = x.contact_id
     AND COALESCE(a.silo, 'BF') = x.silo
     AND a.created_at >= COALESCE(x.sent_at, x.fallback_at) AND a.created_at < COALESCE(x.sent_at, x.fallback_at) + interval '${ATTRIBUTION_DAYS} days'
   WHERE x.campaign_id::text = ANY($1::text[]))
SELECT a.campaign_id::text AS id, COUNT(*)::int AS applications, COUNT(*) FILTER (WHERE ${FUNDED})::int AS funded,
       COALESCE(SUM(a.funded_amount) FILTER (WHERE ${FUNDED}), 0)::float AS funded_amount
  FROM hits a GROUP BY a.campaign_id`;

type Funded = { applications: number; funded: number; funded_amount: number };

const rate = (n: number, of: number): number | null => (of > 0 ? Math.round((n / of) * 1000) / 10 : null);

router.get("/campaign-report", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 730);
  const [emails, texts] = await Promise.all([
    pool.query(EMAIL_CAMPAIGNS_SQL, [silo, days]),
    pool.query(SMS_CAMPAIGNS_SQL, [silo, days]),
  ]);
  const jobIds = emails.rows.map((r: any) => String(r.id));
  const campaignIds = texts.rows.map((r: any) => r.campaign_id).filter(Boolean).map(String);
  const [ef, sf] = await Promise.all([
    jobIds.length ? pool.query(EMAIL_FUNDED_SQL, [jobIds]) : Promise.resolve({ rows: [] as any[] }),
    campaignIds.length ? pool.query(SMS_FUNDED_SQL, [campaignIds]) : Promise.resolve({ rows: [] as any[] }),
  ]);
  const toMap = (rows: any[]) => new Map<string, Funded>(rows.map((r) => [String(r.id), { applications: Number(r.applications) || 0, funded: Number(r.funded) || 0, funded_amount: Number(r.funded_amount) || 0 }]));
  const emailFunded = toMap(ef.rows);
  const smsFunded = toMap(sf.rows);
  const empty: Funded = { applications: 0, funded: 0, funded_amount: 0 };
  const campaigns = [
    ...emails.rows.map((r: any) => {
      // Campaigns sent before the campaign ledger existed only know how many were sent.
      const tracked = Number(r.ledger) > 0;
      const sent = tracked ? Number(r.sent) || 0 : Number(r.job_sent) || 0;
      return {
        id: String(r.id), channel: "email" as const, name: r.subject ?? "(no subject)", status: r.status,
        sent_at: r.finished_at ?? r.created_at, sent,
        opened: tracked ? Number(r.opened) || 0 : null, clicked: tracked ? Number(r.clicked) || 0 : null,
        unsubscribed: tracked ? Number(r.unsubscribed) || 0 : null,
        open_rate: tracked ? rate(Number(r.opened) || 0, sent) : null, click_rate: tracked ? rate(Number(r.clicked) || 0, sent) : null,
        ab: r.ab ?? null, send_time: r.send_time ?? null,
        ...(emailFunded.get(String(r.id)) ?? empty),
      };
    }),
    ...texts.rows.map((r: any) => {
      const sent = Number(r.sent) || 0;
      return {
        id: String(r.id), channel: "sms" as const, name: String(r.body ?? "").slice(0, 80) || "(text)", status: r.status,
        sent_at: r.finished_at ?? r.created_at, sent, opened: null, clicked: Number(r.clicked) || 0, unsubscribed: null,
        open_rate: null, click_rate: rate(Number(r.clicked) || 0, sent), fallback_emails: Number(r.fallback_emails) || 0,
        ...(smsFunded.get(String(r.campaign_id ?? "")) ?? empty),
      };
    }),
  ].sort((a, b) => new Date(String(b.sent_at)).getTime() - new Date(String(a.sent_at)).getTime());
  res.setHeader("Cache-Control", "no-store");
  const totals = campaigns.reduce((t, c: any) => ({
    sent: t.sent + (Number(c.sent) || 0), applications: t.applications + (Number(c.applications) || 0),
    funded: t.funded + (Number(c.funded) || 0), funded_amount: t.funded_amount + (Number(c.funded_amount) || 0),
  }), { sent: 0, applications: 0, funded: 0, funded_amount: 0 });
  return res.json({ ok: true, silo, days, attribution_days: ATTRIBUTION_DAYS, funded_included: true, totals, campaigns });
}));

export default router;
