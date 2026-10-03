// BF_SERVER_APPLICANT_CONSENT_v728
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RECORD_INQUIRY_CONSENT_SQL } from "../services/smsConsent.js";

describe("applicants' texting consent is recorded", () => {
  it("records a 6-month inquiry consent but never downgrades express or client consent", () => {
    expect(RECORD_INQUIRY_CONSENT_SQL).toContain("ELSE 'implied_inquiry' END");
    expect(RECORD_INQUIRY_CONSENT_SQL).toContain("COALESCE(sms_consent,false) OR consent_basis IN ('express','implied_transaction') THEN consent_basis");
  });
  it("is recorded when an application starts and whenever an applicant is saved to the CRM", () => {
    expect(readFileSync("src/routes/publicApplication.ts", "utf8")).toContain("await dbQuery(RECORD_INQUIRY_CONSENT_SQL, [startContactId]);");
    expect(readFileSync("src/services/applicationCrmMirror.ts", "utf8")).toContain("await pool.query(RECORD_INQUIRY_CONSENT_SQL, [contactId]);");
  });
  it("existing applicants and funded clients are backfilled from their own dates", () => {
    const m = readFileSync("migrations/2026_10_03_v728_applicant_consent.sql", "utf8");
    expect(m).toContain("SET consent_basis = 'implied_transaction', consent_at = f.at");
    expect(m).toContain("SET consent_basis = 'implied_inquiry', consent_at = a.at");
    expect(m).toContain("NOT COALESCE(c.sms_consent, false)");
  });
});
