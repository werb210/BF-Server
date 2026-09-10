// BF_SERVER_AD_NEGATIVES_v1
// Propose negative-keyword candidates from the daily warehouse and write the
// terms selected by a marketer back to Google Ads.
import { pool } from "../db.js";
import { accessToken } from "./googleAdsConversions.js";

const API_VERSION = "v18";

export type NegativeCandidate = {
  searchTerm: string;
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
};

// Terms that spent money and converted nothing, worst first. Once a negative
// takes effect, matching queries stop appearing in the warehouse feed.
export async function findNegativeCandidates(days = 7, minCost = 0): Promise<NegativeCandidate[]> {
  const { rows } = await pool.query<{
    search_term: string;
    cost: string;
    clicks: string;
    impressions: string;
    conversions: string;
  }>(
    `SELECT name AS search_term,
            SUM(cost)::numeric(12,2) AS cost,
            SUM(clicks)::int AS clicks,
            SUM(impressions)::int AS impressions,
            SUM(conversions)::numeric(10,2) AS conversions
       FROM google_ads_daily
      WHERE level = 'search_term'
        AND stat_date >= (CURRENT_DATE - ($1)::int)
      GROUP BY name
     HAVING SUM(conversions) = 0 AND SUM(cost) > ($2)::numeric
      ORDER BY SUM(cost) DESC
      LIMIT 200`,
    [days, minCost],
  );

  return rows.map((row) => ({
    searchTerm: row.search_term,
    cost: Number(row.cost ?? 0),
    clicks: Number(row.clicks ?? 0),
    impressions: Number(row.impressions ?? 0),
    conversions: Number(row.conversions ?? 0),
  }));
}

export type AddResult = { added: string[]; failed: Array<{ term: string; error: string }> };

// PHRASE is deliberately the default. A single-word phrase would block every
// query containing that word, so callers must explicitly choose EXACT for it.
export async function addCampaignNegatives(
  campaignId: string,
  terms: string[],
  matchType: "PHRASE" | "EXACT" = "PHRASE",
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
    return true;
  });
  if (usable.length === 0) return { added: [], failed };

  const token = await accessToken();
  const response = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/campaignCriteria:mutate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "developer-token": String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? ""),
        "login-customer-id": String(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? customerId).replace(/[^0-9]/g, ""),
        "Content-Type": "application/json",
      },
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

  const body = await response.json().catch(() => ({} as any));
  if (!response.ok) {
    throw new Error(`google_ads_mutate_failed_${response.status}: ${JSON.stringify(body).slice(0, 400)}`);
  }

  const errors = (body as any)?.partialFailureError?.details ?? [];
  if (Array.isArray(errors) && errors.length > 0) {
    for (const term of usable) failed.push({ term, error: "see_partial_failure" });
    return { added: [], failed };
  }
  return { added: usable, failed };
}
