// BF_SERVER_v951_LINKEDIN_PROFILE_SCOPE
import { describe, expect, it } from "vitest";
import { linkedinScopes } from "../social/networks.js";

describe("LinkedIn sign-in permissions", () => {
  it("asks only for profile posting unless company pages are switched on", () => {
    expect(linkedinScopes({})).toBe("openid profile w_member_social");
    expect(linkedinScopes({ LINKEDIN_COMPANY_PAGES: "off" })).toBe("openid profile w_member_social");
  });
  it("adds the company-page permissions when LINKEDIN_COMPANY_PAGES is on", () => {
    expect(linkedinScopes({ LINKEDIN_COMPANY_PAGES: "on" })).toBe("openid profile w_member_social w_organization_social r_organization_social");
    expect(linkedinScopes({ LINKEDIN_COMPANY_PAGES: " TRUE " })).toContain("w_organization_social");
  });
});
