// BF_SERVER_REFERRAL_LANDING_v2
import { describe, it, expect, beforeEach } from "vitest";
import { referralLandingUrl, normalizeReferralSilos } from "../referralInvite.js";

describe("referral landing routing", () => {
  beforeEach(() => {
    delete process.env.BF_WEBSITE_URL; delete process.env.BI_WEBSITE_URL; delete process.env.WEBSITE_URL;
  });
  it("funding only -> BF-Website /r/f/<code>", () => {
    expect(referralLandingUrl(["BF"], "BF-ABCD")).toBe("https://www.boreal.financial/r/f/BF-ABCD");
  });
  it("funding + PGI -> BF-Website /r/b/<code>", () => {
    expect(referralLandingUrl(["BF", "BI"], "BF-ABCD")).toBe("https://www.boreal.financial/r/b/BF-ABCD");
  });
  it("PGI only -> BI-Website /r/<code>", () => {
    expect(referralLandingUrl(["BI"], "BF-ABCD")).toBe("https://www.boreal.insure/r/BF-ABCD");
  });
  it("SLF is no longer a valid referral silo", () => {
    expect(normalizeReferralSilos(["BF", "SLF", "BI"])).toEqual(["BF", "BI"]);
  });
});
