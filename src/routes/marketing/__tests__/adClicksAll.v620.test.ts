// BF_SERVER_BLOCK_v620_ALL_ADS
import { describe, it, expect } from "vitest";
import { buildClickTree, toLiveAds } from "../adClicks.js";

describe("ad clicks - every ad listed", () => {
  const google = [
    { campaign: { name: "BF Search - US", status: "ENABLED", advertisingChannelType: "SEARCH" }, adGroup: { name: "SBA Loans", status: "ENABLED" }, adGroupAd: { status: "ENABLED", ad: { id: "111", responsiveSearchAd: { headlines: [{ text: "SBA Loans Made Simple" }] } } } },
    { campaign: { name: "BF Search - US", status: "ENABLED", advertisingChannelType: "SEARCH" }, adGroup: { name: "Working Capital", status: "ENABLED" }, adGroupAd: { status: "PAUSED", ad: { id: "999", responsiveSearchAd: { headlines: [{ text: "Working Capital Fast" }] } } } },
    { campaign: { name: "Leads-Performance Max-1", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX" }, adGroup: { name: "x" }, adGroupAd: { ad: { id: "555" } } },
  ];

  it("reads Google's ads, leaving out Performance Max, and marks paused ones", () => {
    const live = toLiveAds(google);
    expect(live.map((a) => a.adId)).toEqual(["111", "999"]);
    expect(live[1]).toMatchObject({ paused: true, headline: "Working Capital Fast" });
  });

  it("adds ads with no CRM clicks at 0, without duplicating clicked ones", () => {
    const t = buildClickTree([{ campaign: "BF Search - US", ad_group: "SBA Loans", ad_id: "111", keyword: "apply for sba loan", clicks: 2 }], toLiveAds(google));
    expect(t.total).toBe(2);
    const us = t.campaigns[0];
    expect(us.adGroups.map((g) => [g.adGroup, g.clicks])).toEqual([["SBA Loans", 2], ["Working Capital", 0]]);
    expect(us.adGroups[0].ads).toHaveLength(1);
    expect(us.adGroups[0].ads[0].label).toBe("Ad 111 - SBA Loans Made Simple");
    expect(us.adGroups[1].ads[0]).toMatchObject({ label: "Ad 999 - Working Capital Fast (paused)", clicks: 0 });
  });
});
