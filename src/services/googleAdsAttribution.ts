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
  clickView?: { gclid?: string; adGroupAd?: string; keywordInfo?: { text?: string; matchType?: string }; areaOfInterest?: unknown; locationOfPresence?: unknown };
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
  const resource = row.clickView?.adGroupAd ?? row.adGroupAd?.resourceName ?? row.adGroupAd?.ad?.resourceName ?? "";
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
      click_view.ad_group_ad,
      click_view.keyword_info.text,
      click_view.keyword_info.match_type
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
      row = await queryClick(gclid, date).catch((err) => {
        console.warn("[google_ads_attribution] click_view query failed", err instanceof Error ? err.message : String(err));
        return null;
      });
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
        row.clickView?.keywordInfo?.text ?? row.adGroupCriterion?.keyword?.text ?? null,
        row.clickView?.keywordInfo?.matchType ?? row.adGroupCriterion?.keyword?.matchType ?? null,
        JSON.stringify({ applicationId: input.applicationId ?? null, ...row }),
      ],
    );
  } catch (err) {
    console.warn("[google_ads_attribution] resolve failed", err instanceof Error ? err.message : String(err));
  }
}

// Retry unresolved Google ad clicks hourly, including clicks on draft applications.
export async function resolvePendingAdAttributions(limit = 100): Promise<{ tried: number; resolved: number }> {
  if (!googleAdsConfigured()) return { tried: 0, resolved: 0 };
  const { rows } = await pool.query<{ contact_id: string; application_id: string; gclid: string; at: string }>(
    `SELECT DISTINCT ON (a.contact_id::text)
            a.contact_id::text AS contact_id, a.id::text AS application_id,
            a.metadata->'attribution'->>'gclid' AS gclid,
            COALESCE(a.metadata->'attribution'->>'capturedAt', a.created_at::text) AS at
       FROM applications a
      WHERE a.silo = 'BF'
        AND a.contact_id IS NOT NULL
        AND COALESCE(a.metadata->'attribution'->>'gclid', '') <> ''
        AND a.created_at > now() - interval '90 days'
        AND NOT EXISTS (SELECT 1 FROM contact_ad_attribution x WHERE x.contact_id::text = a.contact_id::text)
      ORDER BY a.contact_id::text, a.created_at DESC
      LIMIT $1`,
    [limit],
  );
  for (const row of rows) {
    await resolveAndStoreAdAttribution({
      contactId: row.contact_id,
      gclid: row.gclid,
      applicationId: row.application_id,
      occurredAt: row.at,
    });
  }
  const contactIds = rows.map((row) => row.contact_id);
  const resolved = contactIds.length
    ? Number((await pool.query<{ n: number }>(
      `SELECT count(DISTINCT contact_id)::int AS n
         FROM contact_ad_attribution
        WHERE contact_id::text = ANY($1)`,
      [contactIds],
    )).rows[0]?.n ?? 0)
    : 0;
  if (rows.length) console.log("[google_ads_attribution] pending pass", JSON.stringify({ tried: rows.length, resolved }));
  return { tried: rows.length, resolved };
}
