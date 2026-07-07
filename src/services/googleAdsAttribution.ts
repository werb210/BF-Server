// BF_SERVER_AD_ATTRIBUTION_v1 - best-effort gclid -> Google Ads click attribution.
import { pool } from "../db.js";
import { googleAdsConfigured, googleAdsSearch } from "./googleAdsService.js";

type AttributionInput = {
  contactId: string;
  gclid: string;
  applicationId?: string | null;
  occurredAt?: string | Date | null;
};

type ClickRow = {
  campaign?: { id?: string | number; name?: string };
  adGroup?: { id?: string | number; name?: string };
  adGroupAd?: { resourceName?: string; ad?: { id?: string | number; resourceName?: string } };
  adGroupCriterion?: { keyword?: { text?: string; matchType?: string } };
  clickView?: { gclid?: string; areaOfInterest?: unknown; locationOfPresence?: unknown };
  segments?: { date?: string };
};

const DAY_MS = 86_400_000;

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function candidateDates(occurredAt?: string | Date | null): string[] {
  const base = occurredAt ? new Date(occurredAt) : new Date();
  const safe = Number.isNaN(base.getTime()) ? new Date() : base;
  const dates = [0, -1, 1].map((offset) => formatDate(new Date(safe.getTime() + offset * DAY_MS)));
  const min = Date.now() - 90 * DAY_MS;
  return [...new Set(dates)].filter((date) => new Date(`${date}T00:00:00.000Z`).getTime() >= min);
}

function parseAdId(row: ClickRow): string | null {
  const direct = row.adGroupAd?.ad?.id;
  if (direct != null && String(direct)) return String(direct);
  const resource = row.adGroupAd?.resourceName ?? row.adGroupAd?.ad?.resourceName ?? "";
  const match = String(resource).match(/~(\d+)$|\/ads\/(\d+)$/);
  return match?.[1] ?? match?.[2] ?? null;
}

async function queryClick(gclid: string, date: string): Promise<ClickRow | null> {
  const escaped = gclid.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const rows = await googleAdsSearch(`
    SELECT
      segments.date,
      click_view.gclid,
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      ad_group_ad.resource_name,
      ad_group_ad.ad.id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type
    FROM click_view
    WHERE click_view.gclid = '${escaped}'
      AND segments.date = '${date}'
    LIMIT 1
  `);
  return (rows[0] as ClickRow | undefined) ?? null;
}

export async function resolveAndStoreAdAttribution(input: AttributionInput): Promise<void> {
  try {
    const gclid = String(input.gclid ?? "").trim();
    if (!input.contactId || !gclid || !googleAdsConfigured()) return;

    let row: ClickRow | null = null;
    for (const date of candidateDates(input.occurredAt)) {
      row = await queryClick(gclid, date).catch(() => null);
      if (row) break;
    }
    if (!row) return;

    await pool.query(
      `INSERT INTO contact_ad_attribution (
         contact_id, gclid, click_date, campaign_id, campaign_name,
         ad_group_id, ad_group_name, ad_id, keyword, keyword_match_type, raw_click
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (contact_id, gclid) DO UPDATE SET
         click_date = EXCLUDED.click_date,
         campaign_id = EXCLUDED.campaign_id,
         campaign_name = EXCLUDED.campaign_name,
         ad_group_id = EXCLUDED.ad_group_id,
         ad_group_name = EXCLUDED.ad_group_name,
         ad_id = EXCLUDED.ad_id,
         keyword = EXCLUDED.keyword,
         keyword_match_type = EXCLUDED.keyword_match_type,
         raw_click = EXCLUDED.raw_click,
         updated_at = now()`,
      [
        input.contactId,
        gclid,
        row.segments?.date ?? null,
        row.campaign?.id == null ? null : String(row.campaign.id),
        row.campaign?.name ?? null,
        row.adGroup?.id == null ? null : String(row.adGroup.id),
        row.adGroup?.name ?? null,
        parseAdId(row),
        row.adGroupCriterion?.keyword?.text ?? null,
        row.adGroupCriterion?.keyword?.matchType ?? null,
        JSON.stringify({ applicationId: input.applicationId ?? null, ...row }),
      ],
    );
  } catch (err) {
    console.warn("[google_ads_attribution] resolve failed", err instanceof Error ? err.message : String(err));
  }
}
