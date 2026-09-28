// BF_SERVER_NEGATIVE_GUARD_v623
// Stops the Negatives tool from blocking the searches the ads are built for.
// Three kinds of search are protected: the campaign's own live keywords, any
// keyword that has brought in a CRM lead, and any search that has converted in
// the last 90 days. A negative that would block one of them is refused.
// If Google will not return the keyword list, adding negatives is refused
// too (fail closed) - blocking blind is how the ads were damaged.
import { pool } from "../db.js";
import { GOOGLE_ADS_API_VERSION, googleAdsSearch, loginCid } from "./googleAdsService.js";
import { accessToken } from "./googleAdsConversions.js";
import { logError } from "../observability/logger.js";

export type MatchType = "EXACT" | "PHRASE" | "BROAD";

export function normWords(value: unknown): string[] {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[+"\[\]]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Would a negative (term, matchType) stop an ad from showing for this search?
export function negativeBlocks(term: string, matchType: MatchType, search: string): boolean {
  const t = normWords(term);
  const s = normWords(search);
  if (t.length === 0 || s.length === 0) return false;
  if (matchType === "EXACT") return t.length === s.length && t.every((w, i) => w === s[i]);
  if (matchType === "BROAD") { const have = new Set(s); return t.every((w) => have.has(w)); }
  for (let i = 0; i + t.length <= s.length; i++) {
    if (t.every((w, j) => s[i + j] === w)) return true;
  }
  return false;
}

export type LiveKeyword = { campaignId: string; adGroupId: string; text: string };

export async function fetchLiveKeywords(campaignId?: string): Promise<LiveKeyword[]> {
  const cid = String(campaignId ?? "").replace(/[^0-9]/g, "");
  const rows = await googleAdsSearch(
    "SELECT campaign.id, ad_group.id, ad_group_criterion.keyword.text FROM ad_group_criterion" +
    " WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE" +
    " AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'" +
    (cid ? " AND campaign.id = " + cid : ""),
  );
  return rows
    .map((r: any) => ({
      campaignId: String(r?.campaign?.id ?? ""),
      adGroupId: String(r?.adGroup?.id ?? ""),
      text: String(r?.adGroupCriterion?.keyword?.text ?? ""),
    }))
    .filter((k) => k.text);
}

export type Protected = { keywords: string[]; leadKeywords: string[]; convertedSearches: string[] };

export async function protectedSearches(campaignId?: string): Promise<Protected> {
  const cid = campaignId && campaignId.trim() ? campaignId.trim() : null;
  const keywords = (await fetchLiveKeywords(cid ?? undefined)).map((k) => k.text);
  const leads = await pool.query<{ keyword: string }>(
    "SELECT DISTINCT keyword FROM contact_ad_attribution WHERE keyword IS NOT NULL AND keyword <> '' AND ($1::text IS NULL OR campaign_id = $1::text)",
    [cid],
  ).catch((err: any) => { logError("negative_guard_lead_keywords_failed", { message: err?.message }); return { rows: [] as Array<{ keyword: string }> }; });
  const converted = await pool.query<{ name: string }>(
    "SELECT name FROM google_ads_daily WHERE level = 'search_term' AND stat_date >= (CURRENT_DATE - 90) AND ($1::text IS NULL OR campaign_id = $1::text) GROUP BY name HAVING SUM(conversions) > 0",
    [cid],
  ).catch((err: any) => { logError("negative_guard_converted_failed", { message: err?.message }); return { rows: [] as Array<{ name: string }> }; });
  return {
    keywords,
    leadKeywords: leads.rows.map((r) => String(r.keyword)),
    convertedSearches: converted.rows.map((r) => String(r.name)),
  };
}

export function protectionReason(term: string, matchType: MatchType, p: Protected): string | null {
  const kw = p.keywords.find((k) => negativeBlocks(term, matchType, k));
  if (kw) return "would_block_keyword: " + kw;
  const lead = p.leadKeywords.find((k) => negativeBlocks(term, matchType, k));
  if (lead) return "would_block_lead_keyword: " + lead;
  const conv = p.convertedSearches.find((s) => negativeBlocks(term, matchType, s));
  if (conv) return "would_block_converting_search: " + conv;
  return null;
}

export async function accountConversions(days = 30): Promise<number> {
  const { rows } = await pool.query<{ c: string }>(
    "SELECT COALESCE(SUM(conversions), 0)::numeric(12,2) AS c FROM google_ads_daily WHERE level = 'campaign' AND stat_date >= (CURRENT_DATE - ($1)::int)",
    [days],
  ).catch((err: any) => { logError("negative_guard_conversions_failed", { message: err?.message }); return { rows: [{ c: "-1" }] }; });
  return Number(rows[0]?.c ?? -1);
}

export type Conflict = {
  kind: "campaign" | "shared" | "adgroup";
  source: string;
  negative: string;
  matchType: MatchType;
  resourceName: string;
  blocks: string[];
};

const asMatch = (v: unknown): MatchType => (v === "EXACT" ? "EXACT" : v === "BROAD" ? "BROAD" : "PHRASE");

// Negatives already in Google Ads (campaign, ad group or a shared list) that
// block one of the account's own keywords - what Google calls "conflicting".
export async function listConflicts(campaignId?: string): Promise<Conflict[]> {
  const cid = String(campaignId ?? "").replace(/[^0-9]/g, "");
  const keywords = await fetchLiveKeywords();
  const inCampaign = (k: LiveKeyword) => !cid || k.campaignId === cid;
  const out: Conflict[] = [];

  const camp = await googleAdsSearch(
    "SELECT campaign.id, campaign.name, campaign_criterion.resource_name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type" +
    " FROM campaign_criterion WHERE campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD' AND campaign.status != 'REMOVED'",
  );
  for (const r of camp) {
    const id = String(r?.campaign?.id ?? "");
    const neg = String(r?.campaignCriterion?.keyword?.text ?? "");
    const mt = asMatch(r?.campaignCriterion?.keyword?.matchType);
    const blocks = keywords.filter((k) => k.campaignId === id && inCampaign(k) && negativeBlocks(neg, mt, k.text)).map((k) => k.text);
    if (neg && blocks.length) out.push({ kind: "campaign", source: String(r?.campaign?.name ?? id), negative: neg, matchType: mt, resourceName: String(r?.campaignCriterion?.resourceName ?? ""), blocks: Array.from(new Set(blocks)) });
  }

  const ag = await googleAdsSearch(
    "SELECT campaign.id, ad_group.id, ad_group.name, ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type" +
    " FROM ad_group_criterion WHERE ad_group_criterion.negative = TRUE AND ad_group_criterion.type = 'KEYWORD' AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'",
  );
  for (const r of ag) {
    const agId = String(r?.adGroup?.id ?? "");
    const neg = String(r?.adGroupCriterion?.keyword?.text ?? "");
    const mt = asMatch(r?.adGroupCriterion?.keyword?.matchType);
    const blocks = keywords.filter((k) => k.adGroupId === agId && inCampaign(k) && negativeBlocks(neg, mt, k.text)).map((k) => k.text);
    if (neg && blocks.length) out.push({ kind: "adgroup", source: String(r?.adGroup?.name ?? agId), negative: neg, matchType: mt, resourceName: String(r?.adGroupCriterion?.resourceName ?? ""), blocks: Array.from(new Set(blocks)) });
  }

  const links = await googleAdsSearch(
    "SELECT campaign.id, shared_set.id FROM campaign_shared_set WHERE campaign_shared_set.status = 'ENABLED' AND shared_set.type = 'NEGATIVE_KEYWORDS'",
  );
  const campaignsBySet = new Map<string, Set<string>>();
  for (const r of links) {
    const setId = String(r?.sharedSet?.id ?? "");
    if (!campaignsBySet.has(setId)) campaignsBySet.set(setId, new Set());
    campaignsBySet.get(setId)!.add(String(r?.campaign?.id ?? ""));
  }
  const shared = await googleAdsSearch(
    "SELECT shared_set.id, shared_set.name, shared_criterion.resource_name, shared_criterion.keyword.text, shared_criterion.keyword.match_type" +
    " FROM shared_criterion WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'",
  );
  for (const r of shared) {
    const setId = String(r?.sharedSet?.id ?? "");
    const linked = campaignsBySet.get(setId) ?? new Set<string>();
    const neg = String(r?.sharedCriterion?.keyword?.text ?? "");
    const mt = asMatch(r?.sharedCriterion?.keyword?.matchType);
    const blocks = keywords.filter((k) => linked.has(k.campaignId) && inCampaign(k) && negativeBlocks(neg, mt, k.text)).map((k) => k.text);
    if (neg && blocks.length) out.push({ kind: "shared", source: String(r?.sharedSet?.name ?? setId) + " (shared list)", negative: neg, matchType: mt, resourceName: String(r?.sharedCriterion?.resourceName ?? ""), blocks: Array.from(new Set(blocks)) });
  }
  return out;
}

const SERVICE_BY_KIND: Record<string, string> = {
  campaignCriteria: "campaignCriteria",
  adGroupCriteria: "adGroupCriteria",
  sharedCriteria: "sharedCriteria",
};

// Remove one negative by its Google resource name (campaign, ad group or shared list).
export async function removeNegativeCriterion(resourceName: string): Promise<void> {
  const customerId = String(process.env.GOOGLE_ADS_CUSTOMER_ID ?? "").replace(/[^0-9]/g, "");
  if (!customerId) throw new Error("GOOGLE_ADS_CUSTOMER_ID is not set");
  const m = /^customers\/(\d+)\/(campaignCriteria|adGroupCriteria|sharedCriteria)\/[0-9~]+$/.exec(String(resourceName ?? ""));
  if (!m || m[1] !== customerId) throw new Error("resource_name_not_a_negative_in_this_account");
  const service = SERVICE_BY_KIND[m[2]];
  const token = await accessToken();
  const headers: Record<string, string> = {
    Authorization: "Bearer " + token,
    "developer-token": String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? ""),
    "Content-Type": "application/json",
  };
  const lc = loginCid();
  if (lc) headers["login-customer-id"] = lc;
  const response = await fetch(
    "https://googleads.googleapis.com/" + GOOGLE_ADS_API_VERSION + "/customers/" + customerId + "/" + service + ":mutate",
    { method: "POST", headers, body: JSON.stringify({ operations: [{ remove: resourceName }] }) },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error("google_ads_remove_failed_" + response.status + ": " + body.slice(0, 300));
  }
  await pool.query("UPDATE ads_negatives_log SET removed_at = now() WHERE resource_name = $1 AND removed_at IS NULL", [resourceName])
    .catch((err: any) => { logError("negative_conflict_log_update_failed", { resourceName, message: err?.message }); });
}
