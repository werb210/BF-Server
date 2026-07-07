// BF_SERVER_AD_ATTRIBUTION_v1 - static checks for server-side gclid ad attribution.
import { readFileSync } from "fs";
import { join } from "path";

describe("ad attribution v1", () => {
  const root = process.cwd();

  it("creates the contact_ad_attribution table", () => {
    const sql = readFileSync(join(root, "migrations", "2026_07_07_ad_attribution.sql"), "utf-8");
    expect(sql).toContain("BF_SERVER_AD_ATTRIBUTION_v1");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS contact_ad_attribution");
    expect(sql).toContain("UNIQUE (contact_id, gclid)");
  });

  it("exports the Google Ads GAQL runner", () => {
    const svc = readFileSync(join(root, "src", "services", "googleAdsService.ts"), "utf-8");
    expect(svc).toContain("export async function googleAdsSearch");
  });

  it("resolves click_view rows and upserts attribution", () => {
    const svc = readFileSync(join(root, "src", "services", "googleAdsAttribution.ts"), "utf-8");
    expect(svc).toContain("FROM click_view");
    expect(svc).toContain("click_view.gclid");
    expect(svc).toContain("ON CONFLICT (contact_id, gclid) DO UPDATE");
    expect(svc).toContain("catch (err)");
  });

  it("fires resolution from the CRM mirror and exposes the CRM route", () => {
    const mirror = readFileSync(join(root, "src", "services", "applicationCrmMirror.ts"), "utf-8");
    const route = readFileSync(join(root, "src", "routes", "crm.ts"), "utf-8");
    expect(mirror).toContain("resolveAndStoreAdAttribution");
    expect(mirror).toContain("void resolveAndStoreAdAttribution");
    expect(route).toContain('/contacts/:id/ad-attribution');
    expect(route).toContain('contact_ad_attribution');
  });
});
