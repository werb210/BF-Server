// BF_SERVER_ADS_STORY_v707
import { Router } from "express";
import { pool } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { commissionRate } from "../../services/googleDataManager.js";
import { QUALIFIED_STATES } from "../../services/googleAdsLeadSignals.js";

const router = Router();
router.use(requireAuth);

export function windowDays(value: unknown, fallback = 90): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 730 ? Math.floor(n) : fallback;
}
export type StoryBy = "campaign" | "ad_group" | "ad" | "keyword";
export function storyBy(value: unknown): StoryBy {
  return value === "keyword" || value === "ad" || value === "ad_group" ? value : "campaign";
}
const KEY_SQL: Record<StoryBy, string> = {
  campaign: "COALESCE(att.campaign_name, '(unknown campaign)')",
  ad_group: "COALESCE(att.ad_group_name, '(unknown ad group)')",
  ad: "COALESCE(NULLIF(att.ad_id, ''), '(ad not recorded)')",
  keyword: "COALESCE(NULLIF(att.keyword, ''), '(no keyword)')",
};
const SPEND_LEVEL: Partial<Record<StoryBy, string>> = { campaign: "campaign", keyword: "keyword" };
export type StoryRow = { key: string; spend: number | null; clicks: number | null; people: number; started: number; submitted: number; qualified: number; funded: number; fundedAmount: number; commission: number; roas: number | null; costPerSubmit: number | null };
export function buildStoryRows(outcomes: Array<Record<string, unknown>>, spend: Array<Record<string, unknown>>, rate: number): StoryRow[] {
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const map = new Map<string, StoryRow>();
  const blank = (key: string): StoryRow => ({ key, spend: null, clicks: null, people: 0, started: 0, submitted: 0, qualified: 0, funded: 0, fundedAmount: 0, commission: 0, roas: null, costPerSubmit: null });
  for (const s of spend) { const key = String(s.k ?? ""); const row = map.get(key) ?? blank(key); row.spend = num(s.spend); row.clicks = num(s.clicks); map.set(key, row); }
  for (const o of outcomes) { const key = String(o.k ?? ""); const row = map.get(key) ?? blank(key); row.people = num(o.people); row.started = num(o.started); row.submitted = num(o.submitted); row.qualified = num(o.qualified); row.funded = num(o.funded); row.fundedAmount = num(o.funded_amount); map.set(key, row); }
  for (const row of map.values()) { row.commission = Math.round(row.fundedAmount * rate * 100) / 100; row.roas = row.spend && row.spend > 0 ? Math.round(row.commission / row.spend * 100) / 100 : null; row.costPerSubmit = row.spend && row.submitted > 0 ? Math.round(row.spend / row.submitted * 100) / 100 : null; }
  return [...map.values()].sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0) || b.people - a.people);
}
const FUNDED_SQL = "(a.funded_at IS NOT NULL OR a.pipeline_state IN ('Accepted','Funded'))";
const STEP_SQL = `COALESCE(GREATEST(NULLIF(a.metadata->>'furthestStep','')::int, NULLIF(a.metadata->>'currentStep','')::int), NULLIF(a.metadata->>'current_step','')::int, a.current_step, 1)`;

// BF_SERVER_MAYA_ADS_INSIGHTS_v712 - shared report bodies keep staff tools and portal identical.
router.get("/ads-story", safeHandler(async (req: any, res: any) => {
  res.json(await storyReport(windowDays(req.query?.days), storyBy(req.query?.by)));
}));
export async function storyReport(days: number, by: StoryBy) {
  const outcomes = await pool.query(`WITH att AS (SELECT DISTINCT ON (contact_id) contact_id, campaign_name, ad_group_name, ad_id, keyword, click_date FROM contact_ad_attribution WHERE click_date >= CURRENT_DATE - ($1)::int ORDER BY contact_id, click_date DESC NULLS LAST, updated_at DESC)
    SELECT ${KEY_SQL[by]} AS k, COUNT(DISTINCT att.contact_id)::int AS people, COUNT(DISTINCT a.id)::int AS started, COUNT(DISTINCT a.id) FILTER (WHERE a.submitted_at IS NOT NULL)::int AS submitted, COUNT(DISTINCT a.id) FILTER (WHERE lower(COALESCE(a.pipeline_state,'')) = ANY($2))::int AS qualified, COUNT(DISTINCT a.id) FILTER (WHERE ${FUNDED_SQL})::int AS funded, COALESCE(SUM(COALESCE(a.funded_amount,a.requested_amount)) FILTER (WHERE ${FUNDED_SQL}),0)::numeric(14,2) AS funded_amount FROM att LEFT JOIN applications a ON a.contact_id=att.contact_id AND a.silo='BF' GROUP BY 1`, [days, QUALIFIED_STATES]);
  const level = SPEND_LEVEL[by];
  const spend = level ? await pool.query(`SELECT name AS k, SUM(cost)::numeric(14,2) AS spend, SUM(clicks)::int AS clicks FROM google_ads_daily WHERE level=$1 AND stat_date >= CURRENT_DATE - ($2)::int GROUP BY name`, [level, days]) : { rows: [] };
  const rows = buildStoryRows(outcomes.rows, spend.rows, commissionRate());
  const totals = rows.reduce((t, r) => ({ spend:t.spend+(r.spend??0), clicks:t.clicks+(r.clicks??0), people:t.people+r.people, started:t.started+r.started, submitted:t.submitted+r.submitted, qualified:t.qualified+r.qualified, funded:t.funded+r.funded, fundedAmount:t.fundedAmount+r.fundedAmount, commission:t.commission+r.commission }), { spend:0, clicks:0, people:0, started:0, submitted:0, qualified:0, funded:0, fundedAmount:0, commission:0 });
  return { days, by, commissionRate: commissionRate(), spendAvailable:Boolean(level), rows, totals:{...totals, roas: totals.spend > 0 ? Math.round(totals.commission/totals.spend*100)/100 : null} };
}

router.get("/ads-visitors", safeHandler(async (req: any, res: any) => { res.json(await visitorsReport(windowDays(req.query?.days,30), String(req.query?.filter??"all"))); }));
// BF_SERVER_VISITOR_AD_LOOKUP_v713 - Google's own checkers (AdsBot, Googlebot and
// friends) open every ad's final URL with its UTM tags but no click id, one page,
// no time on site. They are not visitors; leave them out.
export const BOT_UA_SQL = "COALESCE(s.user_agent,'') !~* '(bot|crawl|spider|slurp|adsbot|mediapartners|google-ads|googleother|lighthouse|headlesschrome|preview|facebookexternalhit|bingpreview)'";
export async function visitorsReport(days: number, filter: string) { const where=["s.first_seen_at >= now() - ($1 || ' days')::interval", BOT_UA_SQL];
  if(filter==="ad") where.push("COALESCE(s.gclid,s.gbraid,s.wbraid) IS NOT NULL"); if(filter==="identified") where.push("s.contact_id IS NOT NULL"); if(filter==="abandoned") where.push("app.id IS NOT NULL AND app.submitted_at IS NULL"); if(filter==="submitted") where.push("app.submitted_at IS NOT NULL");
  const {rows}=await pool.query(`SELECT s.session_id,s.contact_id,c.name AS contact_name,c.phone AS contact_phone,s.first_seen_at,s.last_seen_at,s.landing_page,s.referrer,(COALESCE(s.gclid,s.gbraid,s.wbraid) IS NOT NULL) AS from_ad,s.utm_source,s.utm_medium,s.utm_campaign,s.utm_term,COALESCE(att.campaign_name,s.ad_campaign_name) AS campaign_name,COALESCE(att.ad_group_name,s.ad_group_name) AS ad_group_name,att.ad_id,COALESCE(att.keyword,s.ad_keyword) AS keyword,COALESCE(att.click_date,s.ad_click_date) AS click_date,(SELECT COUNT(*)::int FROM visitor_events e WHERE e.session_id=s.session_id) AS events,(SELECT COUNT(*)::int FROM visitor_events e WHERE e.session_id=s.session_id AND e.event_type IN ('page_view', 'pageview')) AS pages,(SELECT COALESCE(SUM(e.dwell_ms),0)::bigint FROM visitor_events e WHERE e.session_id=s.session_id) AS dwell_ms,app.id AS application_id,app.step,app.submitted_at,app.pipeline_state,app.funded_amount FROM visitor_sessions s LEFT JOIN contacts c ON c.id::text=s.contact_id LEFT JOIN LATERAL (SELECT x.campaign_name,x.ad_group_name,x.ad_id,x.keyword,x.click_date FROM contact_ad_attribution x WHERE x.gclid=s.gclid ORDER BY x.updated_at DESC LIMIT 1) att ON true LEFT JOIN LATERAL (SELECT a.id,${STEP_SQL} AS step,a.submitted_at,a.pipeline_state,a.funded_amount FROM applications a WHERE s.contact_id IS NOT NULL AND a.contact_id::text=s.contact_id AND a.silo='BF' ORDER BY a.created_at DESC LIMIT 1) app ON true WHERE ${where.join(" AND ")} ORDER BY s.last_seen_at DESC LIMIT 300`,[days]);
  return {days,filter,visitors:rows};
}
router.get("/ads-visitors/:sessionId", safeHandler(async (req:any,res:any)=>{ const id=String(req.params?.sessionId??"").slice(0,100); const session=await pool.query(`SELECT * FROM visitor_sessions WHERE session_id=$1`,[id]); const events=await pool.query(`SELECT event_type,path,title,step,dwell_ms,meta,occurred_at FROM visitor_events WHERE session_id=$1 ORDER BY occurred_at ASC LIMIT 1000`,[id]); res.json({session:session.rows[0]??null,events:events.rows}); }));
router.get("/ads-dropoff", safeHandler(async (req:any,res:any)=>{ res.json(await dropoffReport(windowDays(req.query?.days))); }));
export async function dropoffReport(days: number) { const funnel=await pool.query(`SELECT ${STEP_SQL} AS step,COUNT(*)::int AS stopped,COUNT(*) FILTER (WHERE COALESCE(a.metadata->'attribution'->>'gclid',a.metadata->'attribution'->>'gbraid',a.metadata->'attribution'->>'wbraid','')<>'')::int AS from_ad FROM applications a WHERE a.silo='BF' AND a.submitted_at IS NULL AND a.created_at >= now()-($1||' days')::interval GROUP BY 1 ORDER BY 1`,[days]); const totals=await pool.query(`SELECT COUNT(*)::int AS started,COUNT(*) FILTER (WHERE submitted_at IS NOT NULL)::int AS submitted FROM applications WHERE silo='BF' AND created_at >= now()-($1||' days')::interval`,[days]); const reasons=await pool.query(`SELECT reason,step,COUNT(*)::int AS count,MAX(created_at) AS latest FROM wizard_block_events WHERE created_at >= now()-($1||' days')::interval GROUP BY reason,step ORDER BY count DESC LIMIT 50`,[days]); const fields=await pool.query(`SELECT COALESCE(step,'') AS step,COALESCE(meta->>'field','') AS field,COUNT(*)::int AS count FROM visitor_events WHERE event_type IN ('field_abandon','form_abandon') AND occurred_at >= now()-($1||' days')::interval GROUP BY 1,2 ORDER BY count DESC LIMIT 50`,[days]); const timing=await pool.query(`SELECT step,COUNT(*)::int AS views,ROUND(AVG(dwell_ms))::int AS avg_ms FROM visitor_events WHERE step IS NOT NULL AND dwell_ms IS NOT NULL AND occurred_at >= now()-($1||' days')::interval GROUP BY step ORDER BY step`,[days]); return {days,totals:totals.rows[0]??{started:0,submitted:0},steps:funnel.rows,reasons:reasons.rows,fields:fields.rows,timing:timing.rows}; }
export default router;
