// BF_SERVER_ADS_WAREHOUSE_UPSERT_v417
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const src = read("src/services/googleAdsWarehouse.ts");
const mig = read("migrations/2026_09_22_v414_google_ads_daily_campaign.sql");

describe("v417 the warehouse upsert matches the index v414 created", () => {
  it("conflict target matches uq_google_ads_daily_v414 exactly", () => {
    expect(src).toContain("ON CONFLICT (stat_date, level, name, COALESCE(campaign_id, ''))");
    expect(mig).toContain("(stat_date, level, name, COALESCE(campaign_id, ''))");
  });

  it("no longer names the index v414 dropped", () => {
    expect(src).not.toContain("ON CONFLICT (stat_date, level, name) DO");
  });

  it("upsert accepts and writes the campaign v414 passes it", () => {
    expect(src).toContain("campaignId = \"\"");
    expect(src).toContain("campaign_id, campaign_name, synced_at");
    expect(src).toContain("campaign_name = EXCLUDED.campaign_name");
  });

  it("purges the unattributed rows that would otherwise double count", () => {
    const purge = read("migrations/2026_09_22_v417_purge_unattributed_search_terms.sql");
    expect(purge).toContain("level = 'search_term'");
    expect(purge).toContain("COALESCE(campaign_id, '') = ''");
    expect(purge).toContain("CURRENT_DATE - 30");
  });
});
