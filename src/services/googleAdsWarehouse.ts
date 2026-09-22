// BF_SERVER_ADS_WAREHOUSE_v1 - snapshot Google Ads metrics into google_ads_daily so
// the history is owned locally instead of re-fetched from Google on every page load.
// Segments by date so each day is stored separately. Upserts (idempotent): re-running
// for the same window refreshes those rows rather than duplicating them.
import { googleAdsConfigured, googleAdsSearch } from "./googleAdsService.js";

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const micros = (v: unknown): number => Math.round((num(v) / 1_000_000) * 100) / 100;

function windowDates(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(Date.now() - days * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

async function upsert(
  db: Queryable,
  statDate: string,
  level: string,
  name: string,
  status: string | null,
  m: any,
  // BF_SERVER_ADS_WAREHOUSE_UPSERT_v417 - v414 started passing these at the
  // search-term call site but never widened the signature, so they were dropped.
  campaignId = "",
  campaignName: string | null = null,
): Promise<void> {
  if (!statDate || !name) return;
  await db.query(
    `INSERT INTO google_ads_daily (stat_date, level, name, status, cost, impressions, clicks, conversions, conv_value, campaign_id, campaign_name, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     -- v417: the conflict target must match uq_google_ads_daily_v414 term for
     -- term, COALESCE included, or Postgres rejects every row.
     ON CONFLICT (stat_date, level, name, COALESCE(campaign_id, '')) DO UPDATE SET
       status = EXCLUDED.status, cost = EXCLUDED.cost, impressions = EXCLUDED.impressions,
       clicks = EXCLUDED.clicks, conversions = EXCLUDED.conversions,
       conv_value = EXCLUDED.conv_value, campaign_name = EXCLUDED.campaign_name, synced_at = now()`,
    [statDate, level, name, status, micros(m?.costMicros), num(m?.impressions), num(m?.clicks), num(m?.conversions), num(m?.conversionsValue), campaignId, campaignName],
  );
}

// Snapshot the last `days` days of campaign / keyword / search-term metrics, per day.
export async function snapshotGoogleAds(db: Queryable, days = 30): Promise<{ rows: number; skipped?: string }> {
  if (!googleAdsConfigured()) return { rows: 0, skipped: "google_ads_not_configured" };
  const { start, end } = windowDates(days);
  const W = `segments.date BETWEEN '${start}' AND '${end}'`;
  let rows = 0;

  const camp = await googleAdsSearch(
    `SELECT segments.date, campaign.name, campaign.status, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${W}`,
  );
  for (const r of camp) {
    await upsert(db, String((r as any)?.segments?.date ?? ""), "campaign", String((r as any)?.campaign?.name ?? "(unnamed)"), String((r as any)?.campaign?.status ?? "") || null, (r as any)?.metrics);
    rows += 1;
  }

  const kw = await googleAdsSearch(
    `SELECT segments.date, ad_group_criterion.keyword.text, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM keyword_view WHERE ${W}`,
  );
  for (const r of kw) {
    await upsert(db, String((r as any)?.segments?.date ?? ""), "keyword", String((r as any)?.adGroupCriterion?.keyword?.text ?? "(none)"), null, (r as any)?.metrics);
    rows += 1;
  }

  const st = await googleAdsSearch(
    // BF_SERVER_ADS_WAREHOUSE_CAMPAIGN_v414 - without campaign.id/name here the
    // warehouse could not tell two campaigns apart and rows overwrote each other.
    `SELECT segments.date, search_term_view.search_term, campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE ${W}`,
  );
  for (const r of st) {
    await upsert(db, String((r as any)?.segments?.date ?? ""), "search_term", String((r as any)?.searchTermView?.searchTerm ?? "(none)"), null, (r as any)?.metrics, String((r as any)?.campaign?.id ?? ""), String((r as any)?.campaign?.name ?? "(unknown)"));
    rows += 1;
  }

  return { rows };
}
