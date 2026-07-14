// BF_SERVER_SMS_CONSENT_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isCanadianMobile, CONSENT_SQL, SMS_ELIGIBLE_SQL } from "../services/smsConsent";

const runner = readFileSync(path.join(process.cwd(), "src/services/marketingSendRunner.ts"), "utf8");
const webhook = readFileSync(path.join(process.cwd(), "src/routes/smsInboundWebhook.ts"), "utf8");
const migration = readFileSync(path.join(process.cwd(), "migrations/2026_07_14_sms_consent.sql"), "utf8");

describe("Canada-only", () => {
  it("accepts Canadian area codes", () => {
    expect(isCanadianMobile("+15878881837")).toBe(true);  // 587 Calgary
    expect(isCanadianMobile("+14165096200")).toBe(true);  // 416 Toronto
    expect(isCanadianMobile("778-928-2886")).toBe(true);  // 778 BC
  });
  it("rejects US numbers -- a +1 number is not automatically Canadian", () => {
    expect(isCanadianMobile("+12125551234")).toBe(false); // 212 New York
    expect(isCanadianMobile("+13105551234")).toBe(false); // 310 Los Angeles
  });
  it("rejects malformed input rather than guessing", () => {
    expect(isCanadianMobile(null)).toBe(false);
    expect(isCanadianMobile("")).toBe(false);
    expect(isCanadianMobile("12345")).toBe(false);
  });
});

describe("CASL consent gating", () => {
  it("implied consent expires: 6 months on an inquiry, 2 years on a transaction", () => {
    expect(CONSENT_SQL).toContain("interval '6 months'");
    expect(CONSENT_SQL).toContain("interval '2 years'");
  });
  it("express consent has no expiry", () => {
    expect(CONSENT_SQL).toContain("c.sms_consent");
  });
  it("eligibility requires consent, no opt-out of SMS *or* marketing, and a mobile", () => {
    expect(SMS_ELIGIBLE_SQL).toContain("sms_opt_out");
    expect(SMS_ELIGIBLE_SQL).toContain("marketing_opt_out");
    expect(SMS_ELIGIBLE_SQL).toContain("line_type");
  });
});

describe("the send honours it", () => {
  it("marketing_opt_out is now checked on the SMS path, not just the email fallback", () => {
    expect(runner).toContain("!c.marketing_opt_out && isCanadianMobile(c.phone)");
  });
  it("the recipient query and the count both use the same eligibility rule", () => {
    expect(runner).toContain("SMS_ELIGIBLE_SQL");
  });
  it("supports include and exclude tags like the email composer", () => {
    expect(runner).toContain("excludeTags");
    expect(runner).toContain("NOT (c.tags && $4::text[])");
  });
});

describe("STOP applies everywhere", () => {
  it("the opt-out UPDATE is no longer scoped to silo = 'BF' -- a BI contact's STOP was ignored", () => {
    // Contact *resolution* stays BF-scoped (this is the BF inbound number); only the
    // opt-out write must span silos, because a person saying STOP means stop everywhere.
    const update = webhook.slice(webhook.indexOf("BF_SERVER_SMS_STOP_ALL_SILOS_v1"));
    expect(update).toContain("UPDATE contacts SET sms_opt_out");
    expect(update).not.toContain("WHERE silo = 'BF'");
  });
});

describe("migration", () => {
  it("records the consent basis and backfills it from real application history", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS consent_basis");
    expect(migration).toContain("application_contacts");
    expect(migration).toContain("implied_inquiry");
  });
});
