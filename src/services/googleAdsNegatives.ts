// BF_SERVER_AD_NEGATIVES_v1
// Propose negative-keyword candidates from the daily warehouse and write the
// terms selected by a marketer back to Google Ads.
import { pool } from "../db.js";
import { GOOGLE_ADS_API_VERSION, loginCid } from "./googleAdsService.js";
import { accessToken } from "./googleAdsConversions.js";

const API_VERSION = GOOGLE_ADS_API_VERSION;

// BF_SERVER_AD_NEGATIVES_LOGINCID_v1
// login-customer-id must be the MANAGER id, and must be omitted entirely when
// unset - sending the child id in its place is what a manager hierarchy
// rejects. loginCid() already does this for the services that read the account
// successfully today.
function negativeHeaders(token: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? ""),
    "Content-Type": "application/json",
  };
  const lc = loginCid();
  if (lc) h["login-customer-id"] = lc;
  return h;
}

export type NegativeCandidate = {
  searchTerm: string;
  campaignId?: string | null;
  campaignName?: string | null;
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
};

// Terms that spent money and converted nothing, worst first. Once a negative
// takes effect, matching queries stop appearing in the warehouse feed.
// BF_SERVER_ADS_WAREHOUSE_CAMPAIGN_v414 - the list is now scoped to one campaign,
// because the panel asks staff to apply negatives to a campaign and previously
// showed account-wide terms with no way to tell which campaign spent the money.
export async function findNegativeCandidates(days = 7, minCost = 0, campaignId?: string): Promise<NegativeCandidate[]> {
  const { rows } = await pool.query<{
    search_term: string;
    cost: string;
    clicks: string;
    impressions: string;
    conversions: string;
    campaign_name: string | null;
    campaign_id: string | null;
  }>(
    `SELECT name AS search_term,
            SUM(cost)::numeric(12,2) AS cost,
            SUM(clicks)::int AS clicks,
            SUM(impressions)::int AS impressions,
            SUM(conversions)::numeric(10,2) AS conversions,
            max(campaign_name) AS campaign_name,
            max(campaign_id) AS campaign_id
       FROM google_ads_daily
      WHERE level = 'search_term'
        AND stat_date >= (CURRENT_DATE - ($1)::int)
        AND ($3::text IS NULL OR campaign_id = $3::text)
        -- BF_SERVER_BLOCK_v457_HIDE_BLOCKED_TERMS - drop any search an active negative on
        -- the same campaign already blocks. Its past spend stays inside the window,
        -- so without this a blocked search kept reappearing for up to 90 days.
        -- EXACT blocks that search; PHRASE blocks any search containing the phrase
        -- as whole words. An undone negative (removed_at set) no longer hides it.
        AND NOT EXISTS (
          SELECT 1 FROM ads_negatives_log n
           WHERE n.removed_at IS NULL
             AND n.campaign_id = google_ads_daily.campaign_id
             AND (lower(n.term) = lower(google_ads_daily.name)
                  OR (n.match_type = 'PHRASE'
                      AND strpos(' ' || lower(google_ads_daily.name) || ' ', ' ' || lower(n.term) || ' ') > 0)
                  -- BF_SERVER_BLOCK_v527 - BROAD blocks a search containing every word, in any order.
                  OR (n.match_type = 'BROAD'
                      AND NOT EXISTS (
                        SELECT 1 FROM unnest(string_to_array(lower(n.term), ' ')) AS w(word)
                         WHERE w.word <> ''
                           AND strpos(' ' || lower(google_ads_daily.name) || ' ', ' ' || w.word || ' ') = 0)))
        )
      GROUP BY name, campaign_id, campaign_name
     HAVING SUM(conversions) = 0 AND SUM(cost) > ($2)::numeric
      ORDER BY SUM(cost) DESC
      LIMIT 200`,
    [days, minCost, campaignId && campaignId.trim() ? campaignId.trim() : null],
  );

  return rows.map((row) => ({
    searchTerm: row.search_term,
    cost: Number(row.cost ?? 0),
    clicks: Number(row.clicks ?? 0),
    impressions: Number(row.impressions ?? 0),
    conversions: Number(row.conversions ?? 0),
    campaignId: (row as any).campaign_id ?? null,
    campaignName: (row as any).campaign_name ?? null,
  }));
}

// BF_SERVER_BLOCK_v527 - Google's three negative match types.
export type NegativeMatchType = "PHRASE" | "EXACT" | "BROAD";
export function parseNegativeMatchType(v: unknown): NegativeMatchType {
  return v === "EXACT" ? "EXACT" : v === "BROAD" ? "BROAD" : "PHRASE";
}

export type AddResult = {
  added: string[];
  failed: Array<{ term: string; error: string }>;
  resourceNames?: Record<string, string>;
};

// PHRASE is deliberately the default. A single-word phrase would block every
// query containing that word, so callers must explicitly choose EXACT for it.
export async function addCampaignNegatives(
  campaignId: string,
  terms: string[],
  matchType: NegativeMatchType = "PHRASE",
): Promise<AddResult> {
  const customerId = String(process.env.GOOGLE_ADS_CUSTOMER_ID ?? "").replace(/[^0-9]/g, "");
  if (!customerId) throw new Error("GOOGLE_ADS_CUSTOMER_ID is not set");
  const cid = String(campaignId).replace(/[^0-9]/g, "");
  if (!cid) throw new Error("campaignId must be numeric");

  const clean = Array.from(new Set(terms.map((term) => String(term ?? "").trim()).filter(Boolean)));
  const failed: AddResult["failed"] = [];
  const usable = clean.filter((term) => {
    if (matchType === "PHRASE" && !term.includes(" ")) {
      failed.push({ term, error: "single_word_phrase_rejected_use_exact" });
      return false;
    }
    // A one-word BROAD negative blocks every search with that word in it. Same rule as PHRASE.
    if (matchType === "BROAD" && !term.includes(" ")) {
      failed.push({ term, error: "single_word_broad_rejected_use_exact" });
      return false;
    }
    return true;
  });
  if (usable.length === 0) return { added: [], failed };

  const token = await accessToken();
  const response = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/campaignCriteria:mutate`,
    {
      method: "POST",
      headers: negativeHeaders(token),
      body: JSON.stringify({
        operations: usable.map((term) => ({
          create: {
            campaign: `customers/${customerId}/campaigns/${cid}`,
            negative: true,
            keyword: { text: term, matchType },
          },
        })),
        partialFailure: true,
      }),
    },
  );

  const raw = await response.text().catch(() => "");
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw: raw.slice(0, 300) }; }
  if (!response.ok) {
    const detail = body?.error?.message ?? JSON.stringify(body);
    throw new Error(`google_ads_mutate_failed_${response.status}: ${String(detail).slice(0, 400)}`);
  }

  const errors = (body as any)?.partialFailureError?.details ?? [];
  if (Array.isArray(errors) && errors.length > 0) {
    for (const term of usable) failed.push({ term, error: "see_partial_failure" });
    return { added: [], failed };
  }
  // BF_SERVER_NEGATIVES_SAFETY_v419 - Google returns a resourceName per created
  // criterion. Discarding it made every negative permanent in practice.
  const results = Array.isArray((body as any)?.results) ? (body as any).results : [];
  const resourceNames: Record<string, string> = {};
  usable.forEach((term, i) => {
    const rn = results[i]?.resourceName;
    if (typeof rn === "string" && rn) resourceNames[term] = rn;
  });
  return { added: usable, failed, resourceNames };
}

// v419 - what ELSE does this term block? Answered from our own 90 days of search
// terms, so the warning is about real money and real conversions, not theory.
export type BlastRadius = {
  term: string;
  matchType: NegativeMatchType;
  alsoBlocks: Array<{ searchTerm: string; cost: number; conversions: number }>;
  totalCost: number;
  convertingCount: number;
};

export async function negativeBlastRadius(
  terms: string[],
  matchType: NegativeMatchType,
  campaignId?: string,
  days = 90,
): Promise<BlastRadius[]> {
  const out: BlastRadius[] = [];
  for (const raw of terms) {
    const term = String(raw ?? "").trim();
    if (!term) continue;
    // EXACT blocks only the literal query, so it can never surprise anyone.
    if (matchType === "EXACT") {
      out.push({ term, matchType, alsoBlocks: [], totalCost: 0, convertingCount: 0 });
      continue;
    }
    const { rows } = await pool.query<{ name: string; cost: string; conversions: string }>(
      `SELECT name,
              SUM(cost)::numeric(12,2) AS cost,
              SUM(conversions)::numeric(10,2) AS conversions
         FROM google_ads_daily
        WHERE level = 'search_term'
          AND stat_date >= (CURRENT_DATE - ($2)::int)
          AND ($3::text IS NULL OR campaign_id = $3::text)
          AND name <> $1
          AND (CASE WHEN $4::text = 'BROAD'
                 THEN NOT EXISTS (
                   SELECT 1 FROM unnest(string_to_array(lower($1), ' ')) AS w(word)
                    WHERE w.word <> ''
                      AND strpos(' ' || lower(name) || ' ', ' ' || w.word || ' ') = 0)
                 ELSE name ILIKE ('%' || $1 || '%') END) -- BF_SERVER_BLOCK_v527
        GROUP BY name
        ORDER BY SUM(cost) DESC
        LIMIT 50`,
      [term, days, campaignId && campaignId.trim() ? campaignId.trim() : null, matchType],
    );
    const alsoBlocks = rows.map((row) => ({
      searchTerm: row.name,
      cost: Number(row.cost ?? 0),
      conversions: Number(row.conversions ?? 0),
    }));
    out.push({
      term,
      matchType,
      alsoBlocks,
      totalCost: alsoBlocks.reduce((total, blocked) => total + blocked.cost, 0),
      convertingCount: alsoBlocks.filter((blocked) => blocked.conversions > 0).length,
    });
  }
  return out;
}

// v419 - undo. Google removes a criterion by resourceName.
export async function removeCampaignNegative(resourceName: string): Promise<void> {
  const customerId = String(process.env.GOOGLE_ADS_CUSTOMER_ID ?? "").replace(/[^0-9]/g, "");
  if (!customerId) throw new Error("GOOGLE_ADS_CUSTOMER_ID is not set");
  if (!resourceName) throw new Error("resourceName required");
  const token = await accessToken();
  const response = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/campaignCriteria:mutate`,
    {
      method: "POST",
      headers: negativeHeaders(token),
      body: JSON.stringify({ operations: [{ remove: resourceName }] }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`google_ads_remove_failed_${response.status}: ${body.slice(0, 300)}`);
  }
}
