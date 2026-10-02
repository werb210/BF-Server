// BF_SERVER_VISITOR_AD_LOOKUP_v713 - the campaign, ad group and keyword were only
// looked up in Google for people who started an application, so every anonymous
// ad visitor showed "-" under Ad / keyword. This looks up every ad visit's click
// (gclid) in Google Ads and stores it on the visit. Up to 3 tries, 6 hours apart,
// because Google can take a few hours to publish a click.
import { pool } from "../db.js";
import { logError } from "../observability/logger.js";
import { googleAdsConfigured } from "./googleAdsService.js";
import { queryClick, candidateDates, type ClickRow } from "./googleAdsAttribution.js";

export async function resolveVisitorSessionAds(limit = 100, lookup: (gclid: string, date: string) => Promise<ClickRow | null> = queryClick): Promise<{ tried: number; resolved: number }> {
  if (!googleAdsConfigured()) return { tried: 0, resolved: 0 };
  const { rows } = await pool.query<{ session_id: string; gclid: string; first_seen_at: string }>(
    `SELECT session_id, gclid, first_seen_at FROM visitor_sessions
      WHERE COALESCE(gclid,'') <> '' AND ad_campaign_name IS NULL AND ad_lookup_tries < 3
        AND first_seen_at > now() - interval '89 days'
        AND (ad_lookup_at IS NULL OR ad_lookup_at < now() - interval '6 hours')
      ORDER BY first_seen_at DESC LIMIT $1`,
    [limit],
  );
  let resolved = 0;
  for (const s of rows) {
    let row: ClickRow | null = null;
    for (const date of candidateDates(s.first_seen_at)) {
      try { row = await lookup(s.gclid, date); } catch (err: any) { logError("visitor_ad_lookup_failed", { message: err?.message }); row = null; }
      if (row) break;
    }
    if (row) {
      resolved += 1;
      await pool.query(
        `UPDATE visitor_sessions SET ad_campaign_name = $2, ad_group_name = $3, ad_keyword = $4, ad_click_date = $5::date,
                ad_lookup_at = now(), ad_lookup_tries = ad_lookup_tries + 1 WHERE session_id = $1`,
        [s.session_id, row.campaign?.name ?? null, row.adGroup?.name ?? null, row.clickView?.keywordInfo?.text ?? row.adGroupCriterion?.keyword?.text ?? null, row.segments?.date ?? null],
      );
    } else {
      await pool.query("UPDATE visitor_sessions SET ad_lookup_at = now(), ad_lookup_tries = ad_lookup_tries + 1 WHERE session_id = $1", [s.session_id]);
    }
  }
  if (rows.length) console.log("[visitor_ad_lookup] pass", JSON.stringify({ tried: rows.length, resolved }));
  return { tried: rows.length, resolved };
}
