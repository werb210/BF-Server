// BF_SERVER_BLOCK_v614_AD_CLICKS
// Marketing > Ads > Clicks: every Google Ads click that became a CRM contact, grouped
// campaign > ad group > ad, all time. Source is contact_ad_attribution (the same data
// the contact's Marketing Source card shows). Performance Max is left out.
import { Router } from "express";
import { pool } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { resolveSiloFromRequest } from "../../middleware/silo.js";

export type ClickRow = { campaign: string; ad_group: string; ad_id: string; keyword: string; clicks: number };
export type AdNode = { adId: string; label: string; clicks: number; keywords: Array<{ keyword: string; clicks: number }> };
export type AdGroupNode = { adGroup: string; clicks: number; ads: AdNode[] };
export type CampaignNode = { campaign: string; clicks: number; adGroups: AdGroupNode[] };

const byClicks = <T extends { clicks: number }>(a: T, b: T) => b.clicks - a.clicks;

export function buildClickTree(rows: ClickRow[]): { total: number; campaigns: CampaignNode[] } {
  const campaigns = new Map<string, Map<string, Map<string, AdNode>>>();
  for (const r of rows) {
    const n = Number(r.clicks) || 0;
    if (!campaigns.has(r.campaign)) campaigns.set(r.campaign, new Map());
    const groups = campaigns.get(r.campaign)!;
    if (!groups.has(r.ad_group)) groups.set(r.ad_group, new Map());
    const ads = groups.get(r.ad_group)!;
    const key = r.ad_id || "";
    if (!ads.has(key)) ads.set(key, { adId: key, label: key ? `Ad ${key}` : "Ad not recorded", clicks: 0, keywords: [] });
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
  res.json(buildClickTree(rows));
}));

export default router;
