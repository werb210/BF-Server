// BF_SERVER_MAYA_ADS_TOOLS_v712
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("Maya's Ads report tools", () => {
  it("has a staff tool for each Ads report, each answer carrying the rules", () => {
    const r = readFileSync("src/routes/mayaStaffAdsInsights.ts", "utf8");
    for (const p of ["/staff/ads-story", "/staff/ads-visitors", "/staff/ads-dropoff", "/staff/ads-health", "/staff/ga4", "/staff/ads-audiences"]) expect(r).toContain(`route("${p}"`);
    expect(r).toContain("ad_rules: ADS_RULES");
    expect(readFileSync("src/routes/routeRegistry.ts", "utf8")).toContain("combinedMayaRoutes.use(mayaStaffAdsInsightsRouter)");
  });
});
