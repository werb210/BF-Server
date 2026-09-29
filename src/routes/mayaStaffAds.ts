// BF_SERVER_MAYA_ADS_v683 - Maya can see every Google Ads keyword and negative we hold, and can
// add or remove negatives - but only after the staff member confirms in chat. A change needs a
// preview first: the preview runs the same guard as the Negatives panel (never block our own
// keywords, a lead's keyword or a converting search) and returns a short-lived confirm token;
// the change only happens when Maya sends that token back with confirm: true.
import { createHmac } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { logError } from "../observability/logger.js";
import { verifyMayaService, audit } from "./mayaStaff.js";

type Q = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
const dbq: Q = (sql, params) => pool.query(sql, params as any[]) as any;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const r2 = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
const MATCH = new Set(["EXACT", "PHRASE", "BROAD"]);
const TOKEN_MINUTES = 15;

export function confirmToken(parts: string[], expires: number, secret = process.env.JWT_SECRET || ""): string {
  const sig = createHmac("sha256", secret).update(parts.join("|") + "|" + expires).digest("hex").slice(0, 32);
  return expires + "." + sig;
}
export function tokenValid(token: unknown, parts: string[], now = Date.now(), secret = process.env.JWT_SECRET || ""): boolean {
  const [exp] = String(token ?? "").split(".");
  const expires = Number(exp);
  return Number.isFinite(expires) && expires > now && confirmToken(parts, expires, secret) === String(token);
}

/** Campaigns we have spend data for, with the numeric id Google Ads needs. */
export async function campaignList(q: Q) {
  return (await q(`SELECT DISTINCT ON (campaign_id) campaign_id, campaign_name FROM google_ads_daily
                    WHERE COALESCE(campaign_id, '') <> '' ORDER BY campaign_id, stat_date DESC`, [])).rows
    .map((r) => ({ id: String(r.campaign_id), name: r.campaign_name }));
}

export async function resolveCampaign(q: Q, idOrName: unknown): Promise<{ id: string; name: string | null } | null> {
  const v = String(idOrName ?? "").trim();
  if (!v) return null;
  const list = await campaignList(q);
  const byId = list.find((c) => c.id === v.replace(/[^0-9]/g, "") && /[0-9]/.test(v));
  if (byId) return byId;
  const lower = v.toLowerCase();
  return list.find((c) => String(c.name ?? "").toLowerCase() === lower) ?? list.find((c) => String(c.name ?? "").toLowerCase().includes(lower)) ?? null;
}

export async function adsKeywords(q: Q, days: number, live: () => Promise<Array<{ campaignId: string; adGroupId: string; text: string }>>) {
  const performance = (await q(`SELECT name AS keyword, campaign_name, sum(cost) AS cost, sum(clicks) AS clicks, sum(impressions) AS impressions, sum(conversions) AS conversions
      FROM google_ads_daily WHERE level = 'keyword' AND stat_date >= current_date - $1::int
      GROUP BY name, campaign_name ORDER BY sum(cost) DESC NULLS LAST LIMIT 150`, [days])).rows
    .map((k) => ({ keyword: k.keyword, campaign: k.campaign_name, spend: r2(k.cost), clicks: Number(k.clicks), impressions: Number(k.impressions), conversions: r2(k.conversions) }));
  let active: Array<{ campaign_id: string; keyword: string }> = [];
  let liveNote: string | null = null;
  try {
    active = (await live()).map((k) => ({ campaign_id: k.campaignId, keyword: k.text }));
  } catch (err: any) {
    liveNote = "Google Ads could not be reached for the live keyword list; spend figures come from our daily copy.";
    logError("maya_ads_live_keywords_failed", { message: err?.message });
  }
  return { days, keywords_with_spend: performance, active_keywords: active, campaigns: await campaignList(q), note: liveNote,
    summary: `${performance.length} keyword(s) with spend in the last ${days} day(s); ${active.length} active keyword(s) in Google Ads.` };
}

export async function adsNegatives(q: Q, conflicts: () => Promise<unknown[]>) {
  const negatives = (await q(`SELECT l.id::text AS id, l.campaign_id, l.term, l.match_type, l.added_at,
        COALESCE(l.campaign_name, (SELECT d.campaign_name FROM google_ads_daily d WHERE d.campaign_id = l.campaign_id ORDER BY d.stat_date DESC LIMIT 1)) AS campaign_name
      FROM ads_negatives_log l WHERE l.removed_at IS NULL ORDER BY l.added_at DESC LIMIT 500`, [])).rows;
  let found: unknown[] = [];
  let note: string | null = null;
  try { found = await conflicts(); }
  catch (err: any) {
    note = "Google Ads could not be reached, so conflicts were not checked.";
    logError("maya_ads_conflicts_failed", { message: err?.message });
  }
  return { negatives, conflicts: found, campaigns: await campaignList(q), note,
    summary: `${negatives.length} negative(s) added through the portal are active; ${found.length} negative(s) in Google Ads block one of our own keywords.` };
}

const router = Router();
function route(path: string, tool: string, run: (req: Request) => Promise<any>) {
  router.post(path, safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) return res.status(401).json({ ok: false, error: "service_jwt_required" });
    const args = { ...(req.body ?? {}) };
    try {
      const out = await run(req);
      if (out && out.error) return res.status(out.status ?? 400).json({ ok: false, error: out.error, message: out.message });
      await audit({ audience: "staff", tool, args, ok: true, summary: String(out?.summary ?? ""), sessionId: str(req.body?.session_id) });
      return res.json({ ok: true, ...out });
    } catch (e: any) {
      await audit({ audience: "staff", tool, args, ok: false, summary: e?.message ?? "error", errorCode: tool.replace(/[^a-z]/gi, "_") + "_exception" });
      logError("maya_ads_failed", { tool, error: e?.message ?? "unknown" });
      return res.status(502).json({ ok: false, error: "google_ads_failed", message: e?.message ?? "unknown" });
    }
  }));
}

route("/staff/ads-keywords", "ads.keywords", async (req) => {
  const { fetchLiveKeywords } = await import("../services/googleAdsNegativeGuard.js");
  const days = Math.min(90, Math.max(1, Number(req.body?.days) || 30));
  return adsKeywords(dbq, days, () => fetchLiveKeywords());
});

route("/staff/ads-negatives", "ads.negatives", async () => {
  const { listConflicts } = await import("../services/googleAdsNegativeGuard.js");
  return adsNegatives(dbq, () => listConflicts());
});

route("/staff/ads-negatives/add", "ads.negatives.add", async (req) => {
  const campaign = await resolveCampaign(dbq, req.body?.campaign_id ?? req.body?.campaign);
  if (!campaign) return { error: "campaign_not_found", message: "Name the campaign (or its id) the negatives go on." };
  const matchType = MATCH.has(String(req.body?.match_type ?? "").toUpperCase()) ? String(req.body.match_type).toUpperCase() : "EXACT";
  const terms = Array.from(new Set((Array.isArray(req.body?.terms) ? req.body.terms : []).map((t: unknown) => String(t ?? "").trim()).filter(Boolean))).slice(0, 50) as string[];
  if (!terms.length) return { error: "terms_required" };
  const guard = await import("../services/googleAdsNegativeGuard.js");
  const protectedList = await guard.protectedSearches(campaign.id);
  const refused: Array<{ term: string; reason: string }> = [];
  const allowed = terms.filter((t) => { const why = guard.protectionReason(t, matchType as any, protectedList); if (why) refused.push({ term: t, reason: why }); return !why; });
  const parts = ["add", campaign.id, matchType, ...allowed.slice().sort()];
  if (req.body?.confirm !== true) {
    const token = allowed.length ? confirmToken(parts, Date.now() + TOKEN_MINUTES * 60_000) : null;
    return { preview: true, campaign, match_type: matchType, will_add: allowed, refused, confirm_token: token,
      summary: allowed.length ? `Ready to add ${allowed.length} ${matchType.toLowerCase()} negative(s) to ${campaign.name ?? campaign.id}; ask the user to confirm.` : "Nothing can be added: every term is protected." };
  }
  if (!tokenValid(req.body?.confirm_token, parts)) return { error: "confirmation_required", status: 409, message: "Preview the change first, show it to the user, and send the confirm_token back with confirm: true." };
  const { addCampaignNegatives } = await import("../services/googleAdsNegatives.js");
  const result = await addCampaignNegatives(campaign.id, allowed, matchType as any);
  for (const term of result.added) {
    try {
      await dbq(`INSERT INTO ads_negatives_log (campaign_id, campaign_name, term, match_type, resource_name, added_by) VALUES ($1, $2, $3, $4, $5, NULL)`,
        [campaign.id, campaign.name, term, matchType, result.resourceNames?.[term] ?? null]);
    } catch (err: any) {
      logError("maya_ads_negative_audit_failed", { campaignId: campaign.id, term, message: err?.message });
    }
  }
  return { added: result.added, failed: [...refused.map((r) => ({ term: r.term, error: r.reason })), ...result.failed], campaign,
    summary: `Added ${result.added.length} negative(s) to ${campaign.name ?? campaign.id}.` };
});

route("/staff/ads-negatives/remove", "ads.negatives.remove", async (req) => {
  const id = str(req.body?.id);
  const term = str(req.body?.term);
  const found = (await dbq(`SELECT id::text AS id, campaign_id, term, match_type, resource_name FROM ads_negatives_log
      WHERE removed_at IS NULL AND (($1::text IS NOT NULL AND id::text = $1) OR ($1::text IS NULL AND lower(term) = lower($2)))
      ORDER BY added_at DESC LIMIT 1`, [id, term])).rows[0];
  if (!found?.resource_name) return { error: "not_found", status: 404, message: "Only negatives added through the portal can be removed here." };
  const parts = ["remove", found.id];
  if (req.body?.confirm !== true) {
    return { preview: true, negative: found, confirm_token: confirmToken(parts, Date.now() + TOKEN_MINUTES * 60_000),
      summary: `Ready to remove the ${String(found.match_type).toLowerCase()} negative "${found.term}"; ask the user to confirm.` };
  }
  if (!tokenValid(req.body?.confirm_token, parts)) return { error: "confirmation_required", status: 409, message: "Preview the removal first and send the confirm_token back with confirm: true." };
  const { removeCampaignNegative } = await import("../services/googleAdsNegatives.js");
  await removeCampaignNegative(String(found.resource_name));
  await dbq(`UPDATE ads_negatives_log SET removed_at = now() WHERE id::text = $1`, [found.id]);
  return { removed: found.term, summary: `Removed the negative "${found.term}".` };
});

export default router;
