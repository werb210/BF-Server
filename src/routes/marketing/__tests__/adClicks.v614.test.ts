// BF_SERVER_BLOCK_v614_AD_CLICKS
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildClickTree } from "../adClicks.js";

describe("ad clicks tree", () => {
  it("groups campaign > ad group > ad with keyword counts, busiest first", () => {
    const t = buildClickTree([
      { campaign: "BF Search - US", ad_group: "SBA Loans", ad_id: "111", keyword: "apply for sba loan", clicks: 3 },
      { campaign: "BF Search - US", ad_group: "SBA Loans", ad_id: "111", keyword: "sba loans", clicks: 2 },
      { campaign: "BF Search - US", ad_group: "SBA Loans", ad_id: "222", keyword: "sba 7a loan", clicks: 1 },
      { campaign: "BF Search - US", ad_group: "Working Capital", ad_id: "", keyword: "", clicks: 1 },
      { campaign: "BF Search - Canada", ad_group: "Equipment", ad_id: "333", keyword: "equipment financing canada", clicks: 9 },
    ]);
    expect(t.total).toBe(16);
    expect(t.campaigns.map((c) => [c.campaign, c.clicks])).toEqual([["BF Search - Canada", 9], ["BF Search - US", 7]]);
    const us = t.campaigns[1];
    expect(us.adGroups.map((g) => [g.adGroup, g.clicks])).toEqual([["SBA Loans", 6], ["Working Capital", 1]]);
    expect(us.adGroups[0].ads.map((a) => [a.label, a.clicks])).toEqual([["Ad 111", 5], ["Ad 222", 1]]);
    expect(us.adGroups[0].ads[0].keywords).toEqual([{ keyword: "apply for sba loan", clicks: 3 }, { keyword: "sba loans", clicks: 2 }]);
    expect(us.adGroups[1].ads[0].label).toBe("Ad not recorded");
  });

  it("reads CRM attribution, all time, and leaves out Performance Max", () => {
    const src = readFileSync("src/routes/marketing/adClicks.ts", "utf8");
    expect(src).toContain("FROM contact_ad_attribution a");
    expect(src).toContain("NOT ILIKE '%performance max%'");
    expect(src).not.toContain("interval");
    expect(readFileSync("src/routes/marketing.ts", "utf8")).toContain("router.use(adClicksRoutes)");
  });
});
