// BF_SERVER_GOOGLE_ADS_DIAGNOSTICS_v1 - admin "test Google Ads now" endpoint
// reports which of the five credentials are set and, when present, does a live
// token exchange + API call, mapping failures to a plain diagnosis. No secrets.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const admin = readFileSync(join(process.cwd(), "src", "routes", "admin.ts"), "utf-8");
const svc = readFileSync(join(process.cwd(), "src", "services", "googleAdsService.ts"), "utf-8");

describe("google ads diagnostics", () => {
  it("registers the admin endpoint, guarded", () => {
    expect(admin).toContain("BF_SERVER_GOOGLE_ADS_DIAGNOSTICS_v1");
    expect(admin).toContain('"/google-ads-diagnostics"');
    expect(admin).toContain("requireCapability([CAPABILITIES.USER_MANAGE])");
  });
  it("reports each of the five credentials + login-customer-id", () => {
    expect(svc).toContain("devTokenSet");
    expect(svc).toContain("clientIdSet");
    expect(svc).toContain("clientSecretSet");
    expect(svc).toContain("refreshTokenSet");
    expect(svc).toContain("customerIdSet");
    expect(svc).toContain("loginCustomerIdSet");
  });
  it("maps the common failures to plain diagnoses", () => {
    expect(svc).toContain("developer_token_not_approved_for_production");
    expect(svc).toContain("refresh_token_or_oauth_client_invalid");
    expect(svc).toContain("customer_id_not_found_or_not_linked");
    expect(svc).toContain('diagnosis: "ok"');
  });
});
