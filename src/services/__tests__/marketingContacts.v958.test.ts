// BF_SERVER_v958_MARKETING_CONTACTS - only contacts marked "Marketing contact" get marketing.
import { describe, expect, it } from "vitest";
import { EMAIL_FALLBACK_ELIGIBLE_SQL, MARKETING_CONTACT_SQL, SMS_ELIGIBLE_SQL, CAMPAIGN_ELIGIBLE_SQL } from "../smsConsent.js";
import { EMAIL_BLAST_ELIGIBLE_SQL } from "../marketingSendRunner.js";

describe("marketing contact gate", () => {
  it("every marketing audience requires a marketing contact who has not unsubscribed", () => {
    expect(MARKETING_CONTACT_SQL).toBe("COALESCE(c.marketing_contact, true) = true");
    for (const sql of [SMS_ELIGIBLE_SQL, EMAIL_FALLBACK_ELIGIBLE_SQL, CAMPAIGN_ELIGIBLE_SQL]) expect(sql).toContain(MARKETING_CONTACT_SQL);
    expect(EMAIL_BLAST_ELIGIBLE_SQL).toContain("COALESCE(c.marketing_contact, true) = true");
    expect(EMAIL_BLAST_ELIGIBLE_SQL).toContain("marketing_opt_out");
  });
});
