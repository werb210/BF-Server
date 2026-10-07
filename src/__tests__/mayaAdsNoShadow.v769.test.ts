// BF_SERVER_MAYA_ADS_NO_SHADOW_v769
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const routesIn = (file: string) => [...readFileSync(file, "utf8").matchAll(/^route\("([^"]+)"/gm)].map((m) => m[1]);

describe("each Maya staff ads route is registered once", () => {
  it("no path appears in both ads routers (the first-mounted one would silently win)", () => {
    const a = routesIn("src/routes/mayaStaffAds.ts");
    const b = routesIn("src/routes/mayaStaffAdsInsights.ts");
    expect(a.filter((p) => b.includes(p))).toEqual([]);
  });
  it("the report tools Maya calls are served by the v712 router", () => {
    const b = routesIn("src/routes/mayaStaffAdsInsights.ts");
    for (const p of ["/staff/ads-story", "/staff/ads-visitors", "/staff/ads-dropoff", "/staff/ads-health", "/staff/ga4", "/staff/ads-audiences"]) expect(b).toContain(p);
    expect(routesIn("src/routes/mayaStaffAds.ts")).toEqual(expect.arrayContaining(["/staff/ads-keywords", "/staff/ads-negatives", "/staff/ads-ga4", "/staff/ads-negatives/add", "/staff/ads-negatives/remove"]));
  });
});
