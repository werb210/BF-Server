import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLOSED_STATES, QUALIFIED_STATES, qualifiedPayload, retractionPayload } from "../services/googleAdsLeadSignals.js";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("Google Ads attribution", () => {
  const service = read("src/services/googleAdsAttribution.ts");

  it("queries fields supported by click_view", () => {
    const query = service.slice(service.indexOf("click_view.gclid,"), service.indexOf("FROM click_view"));
    expect(query).toContain("click_view.keyword_info.text");
    expect(query).toContain("click_view.ad_group_ad");
    expect(query).not.toContain("ad_group_criterion");
    expect(query).not.toContain("ad_group_ad.ad.id");
  });

  it("logs query failures and retries unresolved draft clicks from the worker", () => {
    expect(service).toContain('"[google_ads_attribution] click_view query failed"');
    expect(service).toContain("export async function resolvePendingAdAttributions");
    expect(read("src/workers/adConversionWorker.ts")).toContain("await resolvePendingAdAttributions();");
  });

  it("returns the contact-card shape, including attribution from drafts", () => {
    const route = read("src/routes/crm.ts");
    expect(route).toContain('data: { ad: { source: "google_ads", resolved: true, ...resolved.rows[0] }, utm }');
    expect(route).toContain("keyword AS keyword_text");
    expect(route).toContain("application.metadata->'attribution' AS payload");
  });
});

describe("Google Ads click identifiers", () => {
  it("uses gbraid and wbraid for submitted and funded uploads", () => {
    const service = read("src/services/googleAdsConversions.ts");
    expect(service.split('CASE WHEN COALESCE(metadata->\'attribution\'->>\'gclid\',\'\')').length - 1).toBe(2);
    expect(service.split('[p.clickField ?? "gclid"]: p.gclid,').length - 1).toBe(2);
  });

  it("uses the selected click-id field in qualified payloads", () => {
    const body: any = qualifiedPayload({ applicationId: "a1", clickId: "BRAID", clickField: "gbraid", value: 50_000, at: "2026-09-22T10:00:00Z" }, "123", "456", "CAD");
    expect(body.conversions[0].gbraid).toBe("BRAID");
    expect(body.conversions[0].gclid).toBeUndefined();
    expect(body.conversions[0].orderId).toBe("a1-qualified");
    expect(body.conversions[0].conversionAction).toBe("customers/123/conversionActions/456");
  });
});

describe("Google Ads lead-quality signals", () => {
  it("defines qualified and closed states", () => {
    expect(QUALIFIED_STATES).toEqual(["off to lender", "offer", "accepted", "funded"]);
    expect(CLOSED_STATES).toEqual(["rejected", "declined", "withdrawn", "closed"]);
  });

  it("retracts submitted conversions by order id", () => {
    const body: any = retractionPayload(["a9"], "123", "777", new Date("2026-09-22T12:00:00Z"));
    expect(body.conversionAdjustments[0]).toEqual({
      conversionAction: "customers/123/conversionActions/777",
      adjustmentType: "RETRACTION",
      orderId: "a9-submit",
      adjustmentDateTime: "2026-09-22 12:00:00+00:00",
    });
  });

  it("runs signals hourly and exposes status", () => {
    const worker = read("src/workers/adConversionWorker.ts");
    expect(worker).toContain("await uploadQualifiedConversions();");
    expect(worker).toContain("await retractClosedSubmitConversions();");
    expect(read("src/routes/marketing.ts")).toContain('router.get("/google-ads/conversions/status"');
  });
});
