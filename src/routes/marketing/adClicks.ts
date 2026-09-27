// BF_SERVER_BLOCK_v614_AD_CLICKS
// BF_SERVER_BLOCK_v620_ALL_ADS - every live Google Ads search ad is listed, with 0 when
// no click reached the CRM. Clicks still come only from the CRM (contact_ad_attribution);
// Google is asked just for the list of ads (and their first headline). Performance Max is left out.
import { Router } from "express";
import { pool } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { resolveSiloFromRequest } from "../../middleware/silo.js";

export type ClickRow = { campaign: string; ad_group: string; ad_id: string; keyword: string; clicks: number };
export type AdNode = { adId: string; label: string; clicks: number; keywords: Array<{ keyword: string; clicks: number }> };
export type AdGroupNode = { adGroup: string; clicks: number; ads: AdNode[] };
export type CampaignNode = { campaign: string; clicks: number; adGroups: AdGroupNode[] };
export type LiveAd = { campaign: string; adGroup: string; adId: string; headline: string; paused: boolean };

const byClicks = <T extends { clicks: number }>(a: T, b: T) => b.clicks - a.clicks;

export function adLabel(adId: string, live?: LiveAd): string {
  if (!adId) return "Ad not recorded";
  return `Ad ${adId}${live?.headline ? ` - ${live.headline}` : ""}${live?.paused ? " (paused)" : ""}`;
}

export function buildClickTree(rows: ClickRow[], liveAds: LiveAd[] = []): { total: number; campaigns: CampaignNode[] } {
  const live = new Map(liveAds.map((a) => [a.adId, a]));
  const seen = new Set(rows.map((r) => r.ad_id).filter(Boolean));
  const all: ClickRow[] = [
    ...rows,
    ...liveAds.filter((a) => !seen.has(a.adId)).map((a) => ({ campaign: a.campaign, ad_group: a.adGroup, ad_id: a.adId, keyword: "", clicks: 0 })),
  ];
  const campaigns = new Map<string, Map<string, Map<string, AdNode>>>();
  for (const r of all) {
    const n = Number(r.clicks) || 0;
    if (!campaigns.has(r.campaign)) campaigns.set(r.campaign, new Map());
    const groups = campaigns.get(r.campaign)!;
    if (!groups.has(r.ad_group)) groups.set(r.ad_group, new Map());
    const ads = groups.get(r.ad_group)!;
    const key = r.ad_id || "";
    if (!ads.has(key)) ads.set(key, { adId: key, label: adLabel(key, live.get(key)), clicks: 0, keywords: [] });
    const ad = ads.get(key)!;
    ad.clicks += n;
    if (r.keyword) {
      const k = ad.keywords.find((x) => x.keyword === r.keyword);
      if (k) k.clicks += n; else ad.keywords.push({ keyword: r.keyword, clicks: n });
    }
  }
  const out: CampaignNode[] = [];
  for (const [campaign, groups] of campaigns) {
    const adGroups: AdGroupNode[] = [];
    for (const [adGroup, ads] of groups) {
      const list = [...ads.values()].map((a) => ({ ...a, keywords: a.keywords.sort(byClicks) })).sort(byClicks);
      adGroups.push({ adGroup, clicks: list.reduce((s, a) => s + a.clicks, 0), ads: list });
    }
    adGroups.sort(byClicks);
    out.push({ campaign, clicks: adGroups.reduce((s, g) => s + g.clicks, 0), adGroups });
  }
  out.sort(byClicks);
  return { total: out.reduce((s, c) => s + c.clicks, 0), campaigns: out };
}

/** Google rows (REST, camelCase) to LiveAd. Performance Max and removed items are left out. */
export function toLiveAds(rows: any[]): LiveAd[] {
  const out: LiveAd[] = [];
  for (const r of rows) {
    const campaign = String(r?.campaign?.name ?? "");
    const channel = String(r?.campaign?.advertisingChannelType ?? "");
    const adId = r?.adGroupAd?.ad?.id != null ? String(r.adGroupAd.ad.id) : "";
    if (!campaign || !adId || channel === "PERFORMANCE_MAX" || /performance max/i.test(campaign)) continue;
    const headlines = r?.adGroupAd?.ad?.responsiveSearchAd?.headlines;
    const headline = Array.isArray(headlines) && headlines[0]?.text ? String(headlines[0].text) : String(r?.adGroupAd?.ad?.name ?? "");
    const paused = [r?.campaign?.status, r?.adGroup?.status, r?.adGroupAd?.status].some((s) => String(s ?? "") === "PAUSED");
    out.push({ campaign, adGroup: String(r?.adGroup?.name ?? "(ad group)"), adId, headline, paused });
  }
  return out;
}

const ADS_QUERY = `SELECT campaign.name, campaign.status, campaign.advertising_channel_type, ad_group.name, ad_group.status,
  ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.status
  FROM ad_group_ad
  WHERE ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'
    AND campaign.advertising_channel_type != 'PERFORMANCE_MAX'`;

const router = Router();
router.use(requireAuth);

router.get("/ad-clicks", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query<ClickRow>(
    `SELECT COALESCE(NULLIF(a.campaign_name, ''), '(campaign not recorded)') AS campaign,
            COALESCE(NULLIF(a.ad_group_name, ''), '(ad group not recorded)') AS ad_group,
            COALESCE(a.ad_id, '') AS ad_id,
            COALESCE(a.keyword, '') AS keyword,
            COUNT(*)::int AS clicks
       FROM contact_ad_attribution a
       JOIN contacts c ON c.id = a.contact_id
      WHERE c.silo = $1
        AND COALESCE(a.campaign_name, '') NOT ILIKE '%performance max%'
      GROUP BY 1, 2, 3, 4`,
    [silo],
  );
  let liveAds: LiveAd[] = [];
  let adsListError: string | null = null;
  if (silo === "BF") {
    try {
      const { googleAdsConfigured, googleAdsSearch } = await import("../../services/googleAdsService.js");
      if (googleAdsConfigured()) liveAds = toLiveAds(await googleAdsSearch(ADS_QUERY));
      else adsListError = "Google Ads is not connected, so ads with no clicks cannot be listed.";
    } catch (err: any) {
      console.warn("[ad-clicks] Google Ads ad list failed", { message: err?.message ?? String(err) });
      adsListError = "Google Ads did not answer, so ads with no clicks are missing from this list.";
    }
  }
  res.json({ ...buildClickTree(rows, liveAds), adsListError });
}));

export default router;
