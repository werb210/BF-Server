import { ALBERTA_TZ } from "../lib/albertaTime.js"; // BF_SERVER_ALBERTA_TIME_v743 - Alberta is UTC-6 all year
// BF_SERVER_ADS_WEEKLY_EMAIL_v708 - Maya's Monday ads story (suggest-only), once a
// week, Monday morning Edmonton time, to GOOGLE_HEALTH_ALERT_EMAILS (default Todd, Andrew).
import { pool } from "../db.js";
import { logError } from "../observability/logger.js";
import { sendgridConfigured, sendTransactional } from "./sendgridService.js";
import { commissionRate } from "./googleDataManager.js";

export function weeklyRecipients(): string[] {
  return String(process.env.GOOGLE_HEALTH_ALERT_EMAILS || "todd.w@boreal.financial,andrew.p@boreal.financial")
    .split(",").map((s) => s.trim()).filter((s) => s.includes("@"));
}

/** Monday in Edmonton, 08:00-11:59 local; returns that Monday's date (YYYY-MM-DD) or null. */
export function mondayWindow(now: Date): string | null {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ALBERTA_TZ, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour"));
  if (get("weekday") !== "Mon" || hour < 8 || hour > 11) return null;
  return get("year") + "-" + get("month") + "-" + get("day");
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const money = (n: unknown) => "$" + Math.round(Number(n ?? 0)).toLocaleString("en-CA");

export type WeeklyData = {
  spend: number; clicks: number; people: number; started: number; submitted: number; funded: number; fundedAmount: number;
  campaigns: Array<{ name: string; spend: number; clicks: number }>;
  wasted: Array<{ term: string; spend: number; clicks: number }>;
  stops: Array<{ step: number; stopped: number }>;
  suggestions: string[];
};

export function renderWeeklyEmail(d: WeeklyData, rate: number): { subject: string; html: string } {
  const commission = d.fundedAmount * rate;
  const roas = d.spend > 0 ? (commission / d.spend).toFixed(2) + "x" : "-";
  const row = (cells: string[]) => "<tr>" + cells.map((c) => '<td style="padding:4px 8px;border-bottom:1px solid #E4EAF2">' + c + "</td>").join("") + "</tr>";
  const html = [
    '<div style="font-family:Arial,sans-serif;color:#0B1F3A;font-size:14px">',
    "<h2 style=\"margin:0 0 8px\">Google Ads - last 7 days</h2>",
    "<p>Spend " + money(d.spend) + ", " + d.clicks + " clicks, " + d.people + " people reached the CRM, " + d.started + " applications started, " + d.submitted + " submitted, " + d.funded + " funded (" + money(d.fundedAmount) + "). Estimated commission " + money(commission) + ", return on ad spend " + roas + ".</p>",
    d.campaigns.length ? "<h3>Campaigns</h3><table>" + d.campaigns.map((c) => row([esc(c.name), money(c.spend), c.clicks + " clicks"])).join("") + "</table>" : "",
    d.wasted.length ? "<h3>Search terms that cost the most with no application</h3><table>" + d.wasted.map((w) => row([esc(w.term), money(w.spend), w.clicks + " clicks"])).join("") + "</table>" : "",
    d.stops.length ? "<h3>Where unfinished applications stopped</h3><table>" + d.stops.map((s) => row(["Step " + s.step, s.stopped + " stopped"])).join("") + "</table>" : "",
    "<h3>Maya suggests</h3>",
    d.suggestions.length ? "<ul>" + d.suggestions.map((s) => "<li>" + esc(s) + "</li>").join("") + "</ul>" : "<p>No changes suggested this week.</p>",
    '<p style="color:#51617D">Suggestions only - nothing has been changed in Google Ads. Full detail: staff portal, Marketing, Google Ads &amp; Analytics.</p>',
    "</div>",
  ].join("");
  return { subject: "Google Ads weekly: " + money(d.spend) + " spent, " + d.submitted + " submitted, " + d.funded + " funded", html };
}

async function gather(): Promise<WeeklyData> {
  const spend = await pool.query(
    `SELECT name, SUM(cost)::float AS spend, SUM(clicks)::int AS clicks FROM google_ads_daily
      WHERE level = 'campaign' AND stat_date >= CURRENT_DATE - 7 GROUP BY name ORDER BY 2 DESC LIMIT 10`,
  );
  const outcomes = await pool.query(
    `SELECT COUNT(DISTINCT att.contact_id)::int AS people, COUNT(DISTINCT a.id)::int AS started,
            COUNT(DISTINCT a.id) FILTER (WHERE a.submitted_at IS NOT NULL)::int AS submitted,
            COUNT(DISTINCT a.id) FILTER (WHERE a.funded_at IS NOT NULL OR a.pipeline_state IN ('Accepted','Funded'))::int AS funded,
            COALESCE(SUM(COALESCE(a.funded_amount, a.requested_amount)) FILTER (WHERE a.funded_at IS NOT NULL OR a.pipeline_state IN ('Accepted','Funded')), 0)::float AS funded_amount
       FROM contact_ad_attribution att
       LEFT JOIN applications a ON a.contact_id = att.contact_id AND a.silo = 'BF'
      WHERE att.click_date >= CURRENT_DATE - 7`,
  );
  const wasted = await pool.query(
    `SELECT name AS term, SUM(cost)::float AS spend, SUM(clicks)::int AS clicks FROM google_ads_daily
      WHERE level = 'search_term' AND stat_date >= CURRENT_DATE - 7 GROUP BY name HAVING SUM(conversions) = 0
      ORDER BY 2 DESC LIMIT 5`,
  );
  const stops = await pool.query(
    `SELECT COALESCE(GREATEST(NULLIF(metadata->>'furthestStep','')::int, NULLIF(metadata->>'currentStep','')::int), current_step, 1) AS step,
            COUNT(*)::int AS stopped
       FROM applications WHERE silo = 'BF' AND submitted_at IS NULL AND created_at >= now() - interval '7 days'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
  );
  let suggestions: string[] = [];
  try {
    const { suggestionsConfigured, buildSuggestions } = await import("./googleAdsSuggestions.js");
    const { accountConversions } = await import("./googleAdsNegativeGuard.js");
    // BF_SERVER_MAYA_ADS_INSIGHTS_v712 - same rules and full-picture findings as the portal.
    const { fullPictureInsights } = await import("./adsPicture.js");
    for (const i of await fullPictureInsights(7)) suggestions.push(i.title + " - " + i.detail);
    if (suggestionsConfigured()) {
      const built = await buildSuggestions(30);
      const { applyAdRules } = await import("./adsRules.js");
      const ruled = applyAdRules(built.suggestions, { conversions: await accountConversions(30) });
      suggestions.push(...ruled.suggestions.slice(0, 8).map((s: any) => s.title + " - " + s.rationale));
      suggestions.push(...ruled.caveats);
    }
  } catch (err: any) {
    logError("ads_weekly_suggestions_failed", { message: err?.message });
  }
  const o = outcomes.rows[0] ?? {};
  return {
    spend: spend.rows.reduce((t: number, r: any) => t + Number(r.spend || 0), 0),
    clicks: spend.rows.reduce((t: number, r: any) => t + Number(r.clicks || 0), 0),
    people: Number(o.people || 0), started: Number(o.started || 0), submitted: Number(o.submitted || 0),
    funded: Number(o.funded || 0), fundedAmount: Number(o.funded_amount || 0),
    campaigns: spend.rows.map((r: any) => ({ name: String(r.name), spend: Number(r.spend || 0), clicks: Number(r.clicks || 0) })),
    wasted: wasted.rows.map((r: any) => ({ term: String(r.term), spend: Number(r.spend || 0), clicks: Number(r.clicks || 0) })),
    stops: stops.rows.map((r: any) => ({ step: Number(r.step), stopped: Number(r.stopped) })),
    suggestions,
  };
}

/** Sends this week's email if it is Monday morning and it has not gone yet. */
export async function maybeSendWeeklyAdsEmail(now = new Date(), force = false): Promise<{ sent: boolean; reason?: string }> {
  const week = force ? now.toISOString().slice(0, 10) : mondayWindow(now);
  if (!week) return { sent: false, reason: "not_monday_morning" };
  if (!sendgridConfigured()) return { sent: false, reason: "email_not_configured" };
  const claim = await pool.query(
    "INSERT INTO ads_weekly_reports (week_start, recipients) VALUES ($1, $2) ON CONFLICT (week_start) DO NOTHING RETURNING week_start",
    [week, weeklyRecipients().join(",")],
  );
  if (claim.rowCount === 0) return { sent: false, reason: "already_sent" };
  const { subject, html } = renderWeeklyEmail(await gather(), commissionRate());
  let ok = 0;
  for (const to of weeklyRecipients()) {
    const r = await sendTransactional({ to, subject, html }) /* BF_SERVER_TRANSACTIONAL_BYPASS_UNSUB_v761 - a staff report, not marketing */;
    if (r.ok) ok += 1; else logError("ads_weekly_email_failed", { to, status: r.status, error: r.error });
  }
  if (ok === 0) await pool.query("DELETE FROM ads_weekly_reports WHERE week_start = $1", [week]);
  return { sent: ok > 0 };
}
