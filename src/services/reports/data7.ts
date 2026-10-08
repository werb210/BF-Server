// BF_SERVER_REPORTS11_14_v785 - email performance, SMS campaign performance, website pages & devices, lifecycle.
// Boreal Financial silo. What is not recorded is said in each report's note rather than guessed.
import { pool } from "../../db.js";

function days(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1095) : fallback;
}
const r1 = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const STAFF = `COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), u.email, 'Unknown')`;

/** 11. Emails: staff emails (sent, opened) per person; sequence and template emails (sent, opened, clicked). */
export async function emailPerformance(q: Record<string, unknown>) {
  const d = days(q.days, 30);
  const staff = (await pool.query(
    `SELECT ${STAFF} AS label, count(*)::int AS sent, count(*) FILTER (WHERE l.opened_at IS NOT NULL)::int AS opened
       FROM crm_email_log l LEFT JOIN users u ON u.id = l.owner_id
      WHERE COALESCE(l.silo, 'BF') = 'BF' AND l.created_at >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 2 DESC`, [d])).rows;
  const sequences = (await pool.query(
    `SELECT COALESCE(s.name, 'Sequence') AS label, count(*)::int AS sent,
            count(*) FILTER (WHERE x.opened_at IS NOT NULL)::int AS opened, count(*) FILTER (WHERE x.clicked_at IS NOT NULL)::int AS clicked
       FROM sequence_sends x LEFT JOIN marketing_sequences s ON s.id = x.sequence_id
      WHERE x.channel = 'email' AND COALESCE(x.silo, 'BF') = 'BF' AND x.sent_at >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 2 DESC`, [d])).rows;
  const templates = (await pool.query(
    `SELECT COALESCE(NULLIF(t.subject, ''), t.template_id, 'Template') AS label, count(*)::int AS sent,
            count(*) FILTER (WHERE t.opened_at IS NOT NULL)::int AS opened, count(*) FILTER (WHERE t.clicked_at IS NOT NULL)::int AS clicked
       FROM template_send_events t
      WHERE t.channel = 'email' AND COALESCE(t.silo, 'BF') = 'BF' AND t.sent_at >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [d])).rows;
  return { days: d, note: "Opens come from the tracking image, so some email apps undercount them. Replies to staff emails are not tracked.", staff, sequences, templates };
}

/** 12. SMS campaigns and sequence texts: sent, delivered, failed, clicked, replies within 7 days, opt-outs. */
export async function smsCampaignPerformance(q: Record<string, unknown>) {
  const d = days(q.days, 90);
  const campaigns = (await pool.query(
    `SELECT c.id::text AS id, COALESCE(NULLIF(c.tag, ''), left(c.sms_body, 40)) AS label, c.created_at,
            count(x.*)::int AS sent,
            count(*) FILTER (WHERE x.delivery_status = 'delivered')::int AS delivered,
            count(*) FILTER (WHERE x.delivery_status IN ('failed', 'undelivered'))::int AS failed,
            count(*) FILTER (WHERE x.clicked_at IS NOT NULL)::int AS clicked,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM communications_messages m WHERE m.contact_id = x.contact_id AND m.direction = 'inbound'
                                            AND m.created_at > x.sent_at AND m.created_at < x.sent_at + interval '7 days'))::int AS replied,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contacts k WHERE k.id = x.contact_id AND k.sms_opt_out = true AND k.updated_at >= x.sent_at))::int AS opted_out
       FROM sms_campaigns c JOIN sms_campaign_sends x ON x.campaign_id = c.id
      WHERE COALESCE(c.silo, 'BF') = 'BF' AND c.created_at >= now() - ($1 || ' days')::interval
      GROUP BY c.id, c.tag, c.sms_body, c.created_at ORDER BY c.created_at DESC LIMIT 25`, [d])).rows;
  const sequences = (await pool.query(
    `SELECT COALESCE(s.name, 'Sequence') AS label, count(*)::int AS sent,
            count(*) FILTER (WHERE x.delivery_status = 'delivered')::int AS delivered,
            count(*) FILTER (WHERE x.delivery_status IN ('failed', 'undelivered'))::int AS failed,
            count(*) FILTER (WHERE x.clicked_at IS NOT NULL)::int AS clicked
       FROM sequence_sends x LEFT JOIN marketing_sequences s ON s.id = x.sequence_id
      WHERE x.channel = 'sms' AND COALESCE(x.silo, 'BF') = 'BF' AND x.sent_at >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 2 DESC`, [d])).rows;
  return { days: d, note: "Opt-outs count people who opted out after the campaign reached them.", campaigns, sequences };
}

/** 13. Website: landing pages that lead to applications, and visits by device. */
export async function websitePages(q: Record<string, unknown>) {
  const d = days(q.days, 30);
  const base = `FROM visitor_sessions v WHERE v.first_seen_at >= now() - ($1 || ' days')::interval`;
  const applied = `EXISTS (SELECT 1 FROM applications a WHERE v.contact_id IS NOT NULL AND a.contact_id::text = v.contact_id AND a.silo = 'BF' AND a.created_at >= v.first_seen_at)`;
  const pages = (await pool.query(
    `SELECT COALESCE(NULLIF(split_part(split_part(v.landing_page, '?', 1), '#', 1), ''), '(unknown)') AS label,
            count(*)::int AS visits, count(*) FILTER (WHERE ${applied})::int AS applications
       ${base} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [d])).rows;
  const devices = (await pool.query(
    `SELECT CASE WHEN v.user_agent ILIKE '%ipad%' OR v.user_agent ILIKE '%tablet%' THEN 'Tablet'
                 WHEN v.user_agent ILIKE '%mobi%' OR v.user_agent ILIKE '%iphone%' OR v.user_agent ILIKE '%android%' THEN 'Phone'
                 WHEN v.user_agent IS NULL OR v.user_agent = '' THEN 'Unknown' ELSE 'Computer' END AS label,
            count(*)::int AS visits, count(*) FILTER (WHERE ${applied})::int AS applications
       ${base} GROUP BY 1 ORDER BY 2 DESC`, [d])).rows;
  return { days: d, note: "Country is not recorded for website visits.", pages, devices };
}

/** 14. Lifecycle: leads to applicants to submitted to funded to repeat clients, and median days between steps. */
export async function lifecycle(q: Record<string, unknown>) {
  const d = days(q.days, 365);
  const { rows } = await pool.query(
    `WITH c AS (SELECT k.id, k.created_at FROM contacts k WHERE k.silo = 'BF' AND k.created_at >= now() - ($1 || ' days')::interval),
     a AS (SELECT a.contact_id, min(a.created_at) AS first_app, min(a.submitted_at) AS first_submit, min(a.funded_at) AS first_funded,
                  count(*) FILTER (WHERE a.funded_at IS NOT NULL) AS funded_count
             FROM applications a WHERE a.silo = 'BF' AND a.contact_id IS NOT NULL GROUP BY a.contact_id)
     SELECT count(*)::int AS leads,
            count(a.first_app)::int AS applicants,
            count(a.first_submit)::int AS submitted,
            count(a.first_funded)::int AS funded,
            count(*) FILTER (WHERE a.funded_count >= 2)::int AS repeat_clients,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.first_app - c.created_at)) / 86400) FILTER (WHERE a.first_app >= c.created_at) AS lead_to_app,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.first_submit - a.first_app)) / 86400) FILTER (WHERE a.first_submit IS NOT NULL) AS app_to_submit,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.first_funded - a.first_submit)) / 86400) FILTER (WHERE a.first_funded IS NOT NULL AND a.first_submit IS NOT NULL) AS submit_to_funded
       FROM c LEFT JOIN a ON a.contact_id = c.id`, [d]);
  const r = rows[0] ?? {};
  return { days: d, stages: [
    { label: "New contacts (leads)", count: r.leads ?? 0, median_days_to_next: r1(r.lead_to_app) },
    { label: "Started an application", count: r.applicants ?? 0, median_days_to_next: r1(r.app_to_submit) },
    { label: "Submitted to lenders", count: r.submitted ?? 0, median_days_to_next: r1(r.submit_to_funded) },
    { label: "Funded", count: r.funded ?? 0, median_days_to_next: null },
    { label: "Repeat clients (funded twice or more)", count: r.repeat_clients ?? 0, median_days_to_next: null },
  ] };
}
