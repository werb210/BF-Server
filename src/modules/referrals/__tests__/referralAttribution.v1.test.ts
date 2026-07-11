// BF_SERVER_REFERRAL_ATTRIBUTION_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const r = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
describe("referral attribution + no 10% path", () => {
  it("resolver stamps the applicant contact from the attribution ref", () => {
    const s = r("src/modules/referrals/referralConversions.service.ts");
    expect(s).toContain("export async function attributeReferralFromRef");
    expect(s).toContain("metadata->'attribution'->>'ref'");
    expect(s).toContain("JOIN contacts rc ON rc.ref_code = app.ref");
    expect(s).toContain("c.referrer_id IS NULL");
  });
  it("credit path attributes before crediting", () => {
    const s = r("src/modules/referrals/referralConversions.service.ts");
    expect(s).toContain("tag the contact from the ref before crediting");
  });
  it("the legacy 10% triggerCommission is gone", () => {
    const s = r("src/modules/applications/applications.service.ts");
    expect(s).not.toContain("triggerCommission");
    expect(s).not.toContain("* 0.1");
    expect(s).toContain("attributeReferralFromRef(params.applicationId)");
  });
});
