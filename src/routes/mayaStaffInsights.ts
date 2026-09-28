// BF_SERVER_MAYA_INSIGHTS_v655 - read-only answers for Maya (staff audience):
// Google Ads performance and waste, communications, contacts, automations, referrers and to-dos.
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { logError } from "../observability/logger.js";
import { verifyMayaService, audit } from "./mayaStaff.js";
import { contactContextSections } from "../services/crm/contactContext.js";
import { loadCrmTimeline } from "./crm/timeline.js";
import { timelineLines } from "../services/crm/contactBrief.js";
import { buildActionCenter } from "../services/applicantActions.js";

export type Q = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
const dbq: Q = (sql, params) => pool.query(sql, params as any[]) as any;
const str = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
const num = (v: unknown, dflt: number, max: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : dflt; };
const r2 = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;

export async function adsPerformance(q: Q, days: number) {
  const campaigns = (await q(`SELECT name, sum(cost) AS cost, sum(clicks) AS clicks, sum(impressions) AS impressions, sum(conversions) AS conversions,
      sum(cost) FILTER (WHERE stat_date >= current_date - $1::int) AS cost_now, sum(conversions) FILTER (WHERE stat_date >= current_date - $1::int) AS conv_now,
      sum(cost) FILTER (WHERE stat_date < current_date - $1::int) AS cost_prev, sum(conversions) FILTER (WHERE stat_date < current_date - $1::int) AS conv_prev
    FROM google_ads_daily WHERE level = 'campaign' AND stat_date >= current_date - ($1::int * 2) GROUP BY name ORDER BY cost_now DESC NULLS LAST`, [days])).rows.map((c) => ({
      campaign: c.name, spend: r2(c.cost_now), conversions: r2(c.conv_now), previous_spend: r2(c.cost_prev), previous_conversions: r2(c.conv_prev),
      cost_per_conversion: Number(c.conv_now) > 0 ? r2(Number(c.cost_now) / Number(c.conv_now)) : null,
    }));
  const terms = (await q(`SELECT name AS term, campaign_name, sum(cost) AS cost, sum(clicks) AS clicks, sum(conversions) AS conversions
    FROM google_ads_daily WHERE level = 'search_term' AND stat_date >= current_date - $1::int GROUP BY name, campaign_name ORDER BY sum(cost) DESC LIMIT 60`, [days])).rows;
  const wasted = terms.filter((t) => Number(t.cost) > 0 && Number(t.conversions) === 0).slice(0, 15).map((t) => ({ term: t.term, campaign: t.campaign_name, spend: r2(t.cost), clicks: Number(t.clicks) }));
  const converting = terms.filter((t) => Number(t.conversions) > 0).slice(0, 10).map((t) => ({ term: t.term, campaign: t.campaign_name, spend: r2(t.cost), conversions: r2(t.conversions) }));
  const leads = (await q(`SELECT count(*)::int AS n FROM contact_ad_attribution WHERE created_at >= now() - ($1::int * interval '1 day')`, [days])).rows[0]?.n ?? 0;
  const negatives = (await q(`SELECT term, match_type, campaign_name, added_at FROM ads_negatives_log WHERE removed_at IS NULL ORDER BY added_at DESC LIMIT 200`, [])).rows;
  const spend = r2(campaigns.reduce((a, c) => a + c.spend, 0));
  const waste = r2(wasted.reduce((a, w) => a + w.spend, 0));
  return { days, spend, leads_from_ads: leads, campaigns, wasted_search_terms: wasted, wasted_spend: waste, converting_search_terms: converting,
    negatives: { active: negatives.length, recent: negatives.slice(0, 10) }, summary: `Last ${days} day(s): ${spend.toFixed(2)} spend across ${campaigns.length} campaign(s), ${leads} ad lead(s); ${waste.toFixed(2)} on ${wasted.length} search term(s) with no conversions; ${negatives.length} active negative(s).` };
}

export async function commsOverview(q: Q, silo: string, userEmail: string | null) {
  const waiting = (await q(`SELECT * FROM (SELECT DISTINCT ON (m.contact_id) m.contact_id::text AS contact_id, c.name, c.phone, m.body, m.created_at, m.direction, m.read_at
    FROM communications_messages m LEFT JOIN contacts c ON c.id = m.contact_id WHERE m.contact_id IS NOT NULL AND (m.silo = $1 OR m.silo IS NULL) AND m.created_at >= now() - interval '14 days' AND m.direction IN ('inbound', 'outbound')
    ORDER BY m.contact_id, m.created_at DESC) t WHERE direction = 'inbound' ORDER BY created_at ASC LIMIT 25`, [silo])).rows.map((w) => ({ contact_id: w.contact_id, name: w.name, phone: w.phone, last_message: String(w.body ?? "").slice(0, 200), since: w.created_at, unread: !w.read_at }));
  const missed = (await q(`SELECT e.from_number, e.occurred_at AS created_at, c.name, c.id::text AS contact_id FROM call_events e LEFT JOIN contacts c ON c.id = e.contact_id WHERE e.event_type = 'call.missed' AND e.occurred_at >= now() - interval '2 days' AND (e.silo = $1 OR e.silo IS NULL) ORDER BY e.occurred_at DESC LIMIT 15`, [silo])).rows;
  const voicemails = (await q(`SELECT v.from_number, v.created_at, COALESCE(v.transcript, v.transcription) AS transcript, c.name FROM voicemails v LEFT JOIN contacts c ON c.id = v.contact_id WHERE v.created_at >= now() - interval '3 days' AND (v.silo = $1 OR v.silo IS NULL) ORDER BY v.created_at DESC LIMIT 10`, [silo])).rows.map((v) => ({ ...v, transcript: String(v.transcript ?? "").slice(0, 300) }));
  const calls = (await q(`SELECT cf.started_at, cf.direction, c.name, c.id::text AS contact_id, t.voice_intelligence_summary AS summary FROM conferences cf JOIN call_transcripts t ON t.conference_id = cf.id LEFT JOIN contacts c ON c.id = cf.contact_id WHERE t.voice_intelligence_summary IS NOT NULL AND (cf.silo = $1 OR cf.silo IS NULL) ORDER BY cf.started_at DESC NULLS LAST LIMIT 8`, [silo])).rows.map((c) => ({ ...c, summary: String(c.summary ?? "").slice(0, 600) }));
  const issues = (await q(`SELECT id::text AS id, title, status, kind, created_at FROM issues WHERE status = 'open' AND (silo = $1 OR silo IS NULL) ORDER BY created_at DESC LIMIT 10`, [silo])).rows;
  let team: any[] = [];
  if (userEmail) team = (await q(`SELECT ch.name, ch.kind, count(tm.id)::int AS unread FROM users u JOIN team_channel_members mem ON mem.user_id = u.id JOIN team_channels ch ON ch.id = mem.channel_id JOIN team_messages tm ON tm.channel_id = ch.id AND tm.deleted_at IS NULL AND tm.sender_id <> u.id AND tm.created_at > COALESCE(mem.last_read_at, 'epoch'::timestamptz) WHERE lower(u.email) = lower($1) GROUP BY ch.name, ch.kind ORDER BY unread DESC`, [userEmail])).rows;
  return { waiting_on_reply: waiting, missed_calls: missed, voicemails, recent_calls: calls, open_issues: issues, team_unread: team, email_note: "Email lives in Outlook and is read live by the portal Inbox; it is not included here.",
    summary: `${waiting.length} contact(s) waiting on a text reply; ${missed.length} missed call(s) and ${voicemails.length} voicemail(s) recently; ${issues.length} open issue(s)` + (userEmail ? `; ${team.reduce((a, t) => a + t.unread, 0)} unread Team message(s).` : ".") };
}

export async function automationsOverview(q: Q, silo: string) {
  const rules = (await q(`SELECT r.name, r.trigger_type, r.enabled, COALESCE(r.test_mode, false) AS test_mode, count(e.id) FILTER (WHERE e.status = 'active')::int AS active, count(e.id) FILTER (WHERE e.status = 'completed')::int AS completed, count(e.id) FILTER (WHERE e.status = 'failed')::int AS failed FROM automation_rules r LEFT JOIN automation_enrollments e ON e.rule_id = r.id WHERE r.silo = $1 GROUP BY r.id ORDER BY r.enabled DESC, r.name`, [silo])).rows;
  const sequences = (await q(`SELECT s.name, s.status, s.audience_tag, count(e.id) FILTER (WHERE e.status = 'active')::int AS active, count(e.id)::int AS total FROM marketing_sequences s LEFT JOIN marketing_sequence_enrollments e ON e.sequence_id = s.id WHERE s.silo = $1 GROUP BY s.id ORDER BY s.status, s.name`, [silo])).rows;
  const running = rules.filter((r) => r.enabled).length;
  return { automations: rules, sequences, summary: `${running} of ${rules.length} automation(s) enabled; ${sequences.filter((s) => s.status === "active").length} of ${sequences.length} sequence(s) active.` };
}

export async function referrersOverview(q: Q) {
  const referrers = (await q(`SELECT trim(concat_ws(' ', u.first_name, u.last_name)) AS name, u.company_name, u.referrer_status,
    (SELECT count(*)::int FROM contacts c WHERE c.referrer_id = u.id) AS referrals, (SELECT count(*)::int FROM contacts c JOIN applications a ON a.contact_id = c.id WHERE c.referrer_id = u.id) AS applications,
    COALESCE((SELECT sum(credit_amount) FROM referral_conversions r WHERE r.referrer_id = u.id AND r.status = 'credited'), 0) AS owed, COALESCE((SELECT sum(credit_amount) FROM referral_conversions r WHERE r.referrer_id = u.id AND r.status = 'paid'), 0) AS paid
    FROM users u WHERE u.role = 'Referrer' AND u.id <> '00000000-0000-0000-0000-000000000001'::uuid ORDER BY referrals DESC, u.created_at DESC LIMIT 25`, [])).rows.map((r) => ({ ...r, owed: r2(r.owed), paid: r2(r.paid) }));
  const owed = r2(referrers.reduce((a, r) => a + r.owed, 0));
  return { referrers, summary: `${referrers.length} referrer(s); ${owed.toFixed(2)} in commissions credited and not yet paid.` };
}

export async function todoStatus(q: Q, applicationId: string, center: (id: string) => Promise<any>) {
  const c = await center(applicationId);
  const shared = (await q(`SELECT s.document_kind, s.created_at, a.name AS from_application FROM document_shares s LEFT JOIN applications a ON a.id::text = s.source_application_id::text WHERE s.target_application_id::text = $1 ORDER BY s.created_at DESC LIMIT 20`, [applicationId])).rows;
  const outstanding = (c?.outstanding ?? []).map((i: any) => ({ label: i.label, kind: i.kind, rejected: Boolean(i.urgent) }));
  return { outstanding, completed: (c?.completed ?? []).map((i: any) => i.label), shared_from_other_applications: shared, summary: outstanding.length ? `${outstanding.length} item(s) still with the client: ${outstanding.map((o: any) => o.label).join(", ")}.` : "Nothing outstanding for the client." };
}

export async function contactPicture(q: Q, ids: { contactId: string | null; companyId: string | null }, silo: string) {
  const isCompany = !ids.contactId; const id = (ids.contactId ?? ids.companyId) as string;
  const base = isCompany ? (await q(`SELECT to_jsonb(co) AS co, (SELECT to_jsonb(c) FROM contacts c WHERE c.company_id = co.id ORDER BY c.is_primary_applicant DESC NULLS LAST, c.created_at LIMIT 1) AS c FROM companies co WHERE co.id::text = $1`, [id])).rows[0]
    : (await q(`SELECT to_jsonb(c) AS c, to_jsonb(co) AS co FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id::text = $1`, [id])).rows[0];
  if (!base) return null;
  const contact = base.c ?? {}; const company = base.co ?? {};
  const apps = (await q(`SELECT to_jsonb(a) AS a FROM applications a WHERE ${isCompany ? "a.company_id" : "a.contact_id"}::text = $1 ORDER BY a.updated_at DESC NULLS LAST LIMIT 5`, [id])).rows.map((r) => r.a);
  const sections = await contactContextSections(contact, apps); let activity: string[] = [];
  try { activity = timelineLines(await loadCrmTimeline(!isCompany, id, silo), 25); } catch (e: any) { logError("maya_picture_timeline_failed", { error: e?.message }); }
  const pick = (o: any, keys: string[]) => Object.fromEntries(keys.filter((k) => o?.[k] != null && o[k] !== "").map((k) => [k, o[k]]));
  return { contact: pick(contact, ["id", "name", "email", "phone", "job_title", "lifecycle_stage", "lead_status", "tags", "status"]), company: pick(company, ["id", "name", "industry", "website", "address_city", "address_state"]), applications: apps.map((a) => pick(a, ["id", "name", "pipeline_state", "current_stage", "product_category", "requested_amount", "updated_at"])), context: sections, recent_activity: activity, summary: `${contact.name || company.name || "Record"}: ${apps.length} application(s), ${sections.length} context section(s), ${activity.length} recent activity item(s).` };
}

const router = Router();
function route(path: string, tool: string, run: (req: Request) => Promise<any>) {
  router.post(path, safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) return res.status(401).json({ ok: false, error: "service_jwt_required" });
    const args = { ...(req.body ?? {}) }; delete (args as any).user_email;
    try {
      const out = await run(req);
      if (out && out.error) return res.status(out.status ?? 400).json({ ok: false, error: out.error });
      await audit({ audience: "staff", tool, args, ok: true, summary: String(out?.summary ?? ""), sessionId: str(req.body?.session_id) });
      return res.json({ ok: true, ...out });
    } catch (e: any) {
      await audit({ audience: "staff", tool, args, ok: false, summary: e?.message ?? "error", errorCode: tool.replace(/\W/g, "_") + "_exception" });
      logError("maya_insight_failed", { code: "maya_insight_failed", tool, error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "insight_failed" });
    }
  }));
}
const siloOf = (req: Request) => (str(req.body?.silo) ?? "BF").toUpperCase();
route("/staff/ads-performance", "ads.performance", (req) => adsPerformance(dbq, num(req.body?.days, 7, 90)));
route("/staff/comms-overview", "comms.overview", (req) => commsOverview(dbq, siloOf(req), str(req.body?.user_email)));
route("/staff/automations-overview", "automations.overview", (req) => automationsOverview(dbq, siloOf(req)));
route("/staff/referrers-overview", "referrers.overview", () => referrersOverview(dbq));
route("/staff/todo-status", "todo.status", async (req) => { const appId = str(req.body?.application_id); return appId ? todoStatus(dbq, appId, buildActionCenter) : { error: "application_id_required" }; });
route("/staff/contact-picture", "contact.picture", async (req) => { const contactId = str(req.body?.contact_id); const companyId = str(req.body?.company_id); if (!contactId && !companyId) return { error: "contact_id_or_company_id_required" }; return (await contactPicture(dbq, { contactId, companyId }, siloOf(req))) ?? { error: "not_found", status: 404 }; });
export default router;
