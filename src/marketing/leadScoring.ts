// BF_SERVER_v874_MARKETING_TOOLS - lead scoring (ported from KS-server #48, without the Marketing add-on or seats): a
// 0-100 score per contact from
//   rules       who the person is: has a phone, has a business, an owner or executive title, a tag, a lifecycle stage,
//               a lead status, the amount asked for. Admins and Marketing users edit the rules and points, per silo.
//   engagement  what they did in the last 90 days: email opens and clicks, text link clicks, website visits, website
//               form submissions, applications started and submitted. Activity older than 30 days counts half. Each
//               kind has a cap so one busy inbox cannot max out the score.
// Hot is 70 and up, warm 40 and up (both adjustable). Each silo (BF, BI, SLF) has its own rules (boreal_settings
// 'lead_scoring:<silo>') and only scores its own contacts. Scores are kept in lead_scores, refreshed by the
// lead-score worker and whenever the portal looks them up.
import { readSetting, writeSetting, type Q } from "../settingsPack/common.js";

export const RULE_KINDS = ["has_phone", "has_company", "owner_title", "tag", "lifecycle_stage", "lead_status", "amount_at_least"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export type ScoreRule = { kind: RuleKind; value?: string | null; points: number };

export const ENGAGEMENT_KINDS = ["email_open", "email_click", "text_click", "site_visit", "form_submit", "application_started", "application_submitted"] as const;
export type EngagementKind = (typeof ENGAGEMENT_KINDS)[number];
export type EngagementWeight = { points: number; cap: number };

export type ScoringSettings = {
  rules: ScoreRule[];
  engagement: Record<EngagementKind, EngagementWeight>;
  hot: number;
  warm: number;
};

export const ENGAGEMENT_LABELS: Record<EngagementKind, string> = {
  email_open: "Opened an email", email_click: "Clicked a link in an email", text_click: "Clicked a link in a text",
  site_visit: "Visited your website", form_submit: "Filled in a website form", application_started: "Started an application",
  application_submitted: "Submitted an application",
};

export const DEFAULT_SCORING: ScoringSettings = {
  rules: [
    { kind: "has_phone", points: 10 },
    { kind: "has_company", points: 5 },
    { kind: "owner_title", points: 10 },
    { kind: "tag", value: "website_form", points: 10 },
    { kind: "amount_at_least", value: "50000", points: 10 },
  ],
  engagement: {
    email_open: { points: 2, cap: 20 },
    email_click: { points: 5, cap: 25 },
    text_click: { points: 5, cap: 15 },
    site_visit: { points: 3, cap: 15 },
    form_submit: { points: 15, cap: 15 },
    application_started: { points: 20, cap: 20 },
    application_submitted: { points: 30, cap: 30 },
  },
  hot: 70,
  warm: 40,
};

const int = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export function normalizeScoring(raw: unknown): ScoringSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const rules: ScoreRule[] = Array.isArray(r.rules)
    ? r.rules
        .filter((x: any) => (RULE_KINDS as readonly string[]).includes(String(x?.kind)))
        .slice(0, 30)
        .map((x: any) => ({
          kind: String(x.kind) as RuleKind,
          ...(x.value !== undefined && x.value !== null && String(x.value).trim() ? { value: String(x.value).trim().slice(0, 60) } : {}),
          points: int(x.points, -50, 50, 0),
        }))
        .filter((x: ScoreRule) => !["tag", "lifecycle_stage", "lead_status", "amount_at_least"].includes(x.kind) || x.value)
    : DEFAULT_SCORING.rules.map((x) => ({ ...x }));
  const e = (r.engagement && typeof r.engagement === "object" ? r.engagement : {}) as Record<string, any>;
  const engagement = Object.fromEntries(ENGAGEMENT_KINDS.map((k) => {
    const d = DEFAULT_SCORING.engagement[k];
    return [k, { points: int(e[k]?.points, 0, 50, d.points), cap: int(e[k]?.cap, 0, 100, d.cap) }];
  })) as Record<EngagementKind, EngagementWeight>;
  const hot = int(r.hot, 1, 100, DEFAULT_SCORING.hot);
  const warm = Math.min(int(r.warm, 0, 100, DEFAULT_SCORING.warm), hot);
  return { rules, engagement, hot, warm };
}

export type ScoringSilo = "BF" | "BI" | "SLF";
export const SCORING_SILOS: readonly ScoringSilo[] = ["BF", "BI", "SLF"];
export const scoringSilo = (raw: unknown): ScoringSilo => {
  const v = String(raw ?? "").toUpperCase();
  return v === "BI" || v === "SLF" ? v : "BF";
};
const settingKey = (silo: ScoringSilo) => `lead_scoring:${silo}`;

export async function scoringSettings(db: Q, silo: ScoringSilo = "BF"): Promise<ScoringSettings> {
  return readSetting(db, settingKey(silo), normalizeScoring);
}
export async function saveScoringSettings(db: Q, s: ScoringSettings, actor: string | null, silo: ScoringSilo = "BF"): Promise<void> {
  await writeSetting(db, settingKey(silo), s, actor);
}

export type ContactFacts = {
  id: string;
  phone: string | null;
  has_company: boolean;
  job_title: string | null;
  tags: string[];
  lifecycle_stage: string | null;
  lead_status: string | null;
  requested_amount: number | null;
  /** Counts in the last 90 days: [recent (30 days), older]. */
  activity: Partial<Record<EngagementKind, [number, number]>>;
};

export type Score = {
  contact_id: string;
  score: number;
  rules_points: number;
  engagement_points: number;
  grade: "hot" | "warm" | "cold";
  breakdown: Array<{ label: string; points: number }>;
};

const OWNER_TITLE = /\b(owner|founder|co-founder|ceo|president|principal|partner|managing director|proprietor|cfo|director)\b/i;

function ruleLabel(r: ScoreRule): string {
  switch (r.kind) {
    case "has_phone": return "Has a phone number";
    case "has_company": return "Has a business on file";
    case "owner_title": return "Owner or executive title";
    case "tag": return `Tagged "${r.value}"`;
    case "lifecycle_stage": return `Lifecycle stage is ${r.value}`;
    case "lead_status": return `Lead status is ${r.value}`;
    case "amount_at_least": return `Asked for $${Number(r.value).toLocaleString("en-CA")} or more`;
  }
}

function ruleMatches(r: ScoreRule, c: ContactFacts): boolean {
  const eq = (a: string | null, b: string | null | undefined) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
  switch (r.kind) {
    case "has_phone": return String(c.phone ?? "").replace(/\D/g, "").length >= 7;
    case "has_company": return c.has_company;
    case "owner_title": return OWNER_TITLE.test(String(c.job_title ?? ""));
    case "tag": return c.tags.some((t) => eq(t, r.value));
    case "lifecycle_stage": return eq(c.lifecycle_stage, r.value);
    case "lead_status": return eq(c.lead_status, r.value);
    case "amount_at_least": return c.requested_amount !== null && Number(r.value) > 0 && c.requested_amount >= Number(r.value);
  }
}

/** The score for one contact. Pure. */
export function computeScore(c: ContactFacts, s: ScoringSettings): Score {
  const breakdown: Score["breakdown"] = [];
  let rules = 0;
  for (const r of s.rules) {
    if (!ruleMatches(r, c) || r.points === 0) continue;
    rules += r.points;
    breakdown.push({ label: ruleLabel(r), points: r.points });
  }
  let engagement = 0;
  for (const k of ENGAGEMENT_KINDS) {
    const [recent, older] = c.activity[k] ?? [0, 0];
    if (!recent && !older) continue;
    const w = s.engagement[k];
    const raw = recent * w.points + older * w.points * 0.5;
    const pts = Math.round(Math.min(w.cap, raw));
    if (pts <= 0) continue;
    engagement += pts;
    breakdown.push({ label: `${ENGAGEMENT_LABELS[k]} (${recent + older})`, points: pts });
  }
  const score = Math.max(0, Math.min(100, rules + engagement));
  return {
    contact_id: c.id, score, rules_points: rules, engagement_points: engagement,
    grade: score >= s.hot ? "hot" : score >= s.warm ? "warm" : "cold",
    breakdown,
  };
}

// --------------------------------------------------------------------------------------------- facts from the db

const FACTS_SQL = `SELECT c.id::text AS id, c.phone, (c.company_id IS NOT NULL OR COALESCE(c.company_name, '') <> '') AS has_company,
       c.job_title, COALESCE(c.tags, '{}') AS tags, c.lifecycle_stage, c.lead_status,
       (SELECT MAX(a.requested_amount)::float FROM applications a WHERE a.contact_id = c.id) AS requested_amount
  FROM contacts c WHERE c.id::text = ANY($1::text[]) AND COALESCE(c.silo, 'BF') = $2 AND c.merged_into_id IS NULL`;

// Each row: contact, kind, recent (last 30 days), older (31-90 days).
const ACTIVITY_SQL = `
SELECT contact_id::text AS id, CASE event_type WHEN 'email_open' THEN 'email_open' WHEN 'email_click' THEN 'email_click' ELSE 'form_submit' END AS kind,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS recent,
       COUNT(*) FILTER (WHERE created_at < now() - interval '30 days')::int AS older
  FROM crm_timeline_events
 WHERE contact_id::text = ANY($1::text[]) AND event_type IN ('email_open', 'email_click', 'website_form_submitted', 'contact_form_submitted')
   AND created_at >= now() - interval '90 days'
 GROUP BY 1, 2
UNION ALL
SELECT contact_id::text, 'text_click', COUNT(*) FILTER (WHERE clicked_at >= now() - interval '30 days')::int,
       COUNT(*) FILTER (WHERE clicked_at < now() - interval '30 days')::int
  FROM sms_campaign_sends WHERE contact_id::text = ANY($1::text[]) AND clicked_at >= now() - interval '90 days' GROUP BY 1
UNION ALL
SELECT contact_id::text, 'text_click', COUNT(*) FILTER (WHERE clicked_at >= now() - interval '30 days')::int,
       COUNT(*) FILTER (WHERE clicked_at < now() - interval '30 days')::int
  FROM sequence_sends WHERE channel = 'sms' AND contact_id::text = ANY($1::text[]) AND clicked_at >= now() - interval '90 days' GROUP BY 1
UNION ALL
SELECT contact_id, 'site_visit', COUNT(*) FILTER (WHERE last_seen_at >= now() - interval '30 days')::int,
       COUNT(*) FILTER (WHERE last_seen_at < now() - interval '30 days')::int
  FROM visitor_sessions WHERE contact_id = ANY($1::text[]) AND last_seen_at >= now() - interval '90 days' GROUP BY 1
UNION ALL
SELECT contact_id::text, 'application_started', COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int,
       COUNT(*) FILTER (WHERE created_at < now() - interval '30 days')::int
  FROM applications WHERE contact_id::text = ANY($1::text[]) AND created_at >= now() - interval '90 days' GROUP BY 1
UNION ALL
SELECT contact_id::text, 'application_submitted', COUNT(*) FILTER (WHERE submitted_at >= now() - interval '30 days')::int,
       COUNT(*) FILTER (WHERE submitted_at < now() - interval '30 days')::int
  FROM applications WHERE contact_id::text = ANY($1::text[]) AND submitted_at >= now() - interval '90 days' GROUP BY 1`;

/** Facts for the contacts among `ids` that belong to `silo` (others are left out). */
export async function contactFacts(db: Q, ids: string[], silo: ScoringSilo = "BF"): Promise<ContactFacts[]> {
  if (!ids.length) return [];
  const [facts, activity] = await Promise.all([db.query(FACTS_SQL, [ids, silo]), db.query(ACTIVITY_SQL, [ids])]);
  const byId = new Map<string, ContactFacts>();
  for (const r of facts.rows) {
    byId.set(String(r.id), {
      id: String(r.id), phone: r.phone ?? null, has_company: r.has_company === true, job_title: r.job_title ?? null,
      tags: Array.isArray(r.tags) ? r.tags.map(String) : [], lifecycle_stage: r.lifecycle_stage ?? null, lead_status: r.lead_status ?? null,
      requested_amount: r.requested_amount === null || r.requested_amount === undefined ? null : Number(r.requested_amount), activity: {},
    });
  }
  for (const a of activity.rows) {
    const c = byId.get(String(a.id));
    if (!c || !(ENGAGEMENT_KINDS as readonly string[]).includes(String(a.kind))) continue;
    const k = String(a.kind) as EngagementKind;
    const prev = c.activity[k] ?? [0, 0];
    c.activity[k] = [prev[0] + (Number(a.recent) || 0), prev[1] + (Number(a.older) || 0)];
  }
  return [...byId.values()];
}

/** Scores the silo's contacts among `ids` (others are ignored) and keeps the result in lead_scores. */
export async function scoreContacts(db: Q, ids: string[], silo: ScoringSilo = "BF", settings?: ScoringSettings): Promise<Score[]> {
  const unique = [...new Set(ids.map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 500);
  if (!unique.length) return [];
  const s = settings ?? (await scoringSettings(db, silo));
  const scores = (await contactFacts(db, unique, silo)).map((c) => computeScore(c, s));
  if (scores.length) {
    await db.query(
      `INSERT INTO lead_scores (contact_id, silo, score, rules_points, engagement_points, breakdown, computed_at)
       SELECT (x->>'contact_id')::uuid, $2, (x->>'score')::int, (x->>'rules_points')::int, (x->>'engagement_points')::int, x->'breakdown', now()
         FROM jsonb_array_elements($1::jsonb) x
       ON CONFLICT (contact_id) DO UPDATE SET silo = EXCLUDED.silo, score = EXCLUDED.score, rules_points = EXCLUDED.rules_points,
         engagement_points = EXCLUDED.engagement_points, breakdown = EXCLUDED.breakdown, computed_at = now()`,
      [JSON.stringify(scores), silo],
    );
  }
  return scores;
}

/** A silo's contacts to refresh: recent activity (2 days) first, then those never scored or scored over a day ago. */
export const STALE_CONTACTS_SQL = `SELECT t.id FROM (
  SELECT DISTINCT contact_id::text AS id, 0 AS pri FROM crm_timeline_events WHERE contact_id IS NOT NULL AND created_at >= now() - interval '2 days'
  UNION SELECT DISTINCT contact_id, 0 FROM visitor_sessions WHERE contact_id IS NOT NULL AND last_seen_at >= now() - interval '2 days'
  UNION SELECT c.id::text, 1 FROM contacts c LEFT JOIN lead_scores ls ON ls.contact_id = c.id
   WHERE c.merged_into_id IS NULL AND COALESCE(c.silo, 'BF') = $2 AND (ls.contact_id IS NULL OR ls.computed_at < now() - interval '1 day')
) t JOIN contacts c ON c.id::text = t.id AND COALESCE(c.silo, 'BF') = $2 AND c.merged_into_id IS NULL
 ORDER BY t.pri LIMIT $1`;
