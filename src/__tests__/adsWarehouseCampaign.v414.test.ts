// BF_SERVER_ADS_WAREHOUSE_CAMPAIGN_v414
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("v414 ads warehouse keeps campaigns apart", () => {
  it("asks Google for the campaign on search-term rows", () => {
    const src = read("src/services/googleAdsWarehouse.ts");
    expect(src).toContain("BF_SERVER_ADS_WAREHOUSE_CAMPAIGN_v414");
    expect(src).toContain("campaign.id, campaign.name");
    expect(src).toContain("FROM search_term_view");
  });

  it("widens the natural key so two campaigns no longer overwrite each other", () => {
    const sql = read("migrations/2026_09_22_v414_google_ads_daily_campaign.sql");
    expect(sql).toContain("DROP INDEX IF EXISTS uq_google_ads_daily");
    expect(sql).toContain("uq_google_ads_daily_v414");
    expect(sql).toContain("COALESCE(campaign_id, '')");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS campaign_id");
  });

  it("scopes the candidate list to a campaign when one is given", () => {
    const src = read("src/services/googleAdsNegatives.ts");
    expect(src).toContain("campaignId?: string");
    expect(src).toContain("($3::text IS NULL OR campaign_id = $3::text)");
    expect(src).toContain("GROUP BY name, campaign_id, campaign_name");
  });

  it("returns the campaign with each candidate", () => {
    const src = read("src/services/googleAdsNegatives.ts");
    expect(src).toContain("campaignName?: string | null");
    expect(src).toContain("campaignName: (row as any).campaign_name");
  });

  it("the route forwards campaignId", () => {
    const src = read("src/routes/marketing.ts");
    expect(src).toContain('req.query.campaignId');
    expect(src).toContain("findNegativeCandidates(days, minCost, campaignId || undefined)");
  });
});
