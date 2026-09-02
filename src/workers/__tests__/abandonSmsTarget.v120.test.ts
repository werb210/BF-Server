// BF_SERVER_ABANDON_SMS_TARGET_v120 (updated by BF_SERVER_ABANDON_NUDGE_OTP_TARGET_v162)
// v120's original intent: never blast the Step-3 business switchboard or a
// fictional number. v120 implemented that by targeting application_contacts
// (role='applicant') - but that row is written only at SUBMIT, so it excluded
// every (never-submitted) abandoned application and the nudge went fully dark.
// v162 keeps the safety intent while fixing the outage: target the OTP-verified
// mobile on a.contact_id, gated by the 'application_started' tag (written only at
// application start, never on a business/company contact), plus all the original
// deliverability guards. These assertions pin that safety contract.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "..", "abandonedApplicationWorker.ts"), "utf-8");

describe("recipient", () => {
  it("targets the OTP-verified contact captured at start", () => {
    expect(src).toContain("JOIN contacts c ON c.id = a.contact_id");
  });

  it("only ever nudges a contact proven to be the OTP lead (never the switchboard)", () => {
    expect(src).toContain("'application_started' = ANY(COALESCE(c.tags, '{}'))");
  });

  it("does not gate on the submit-only applicant role (that is what broke it)", () => {
    // The 4-hour SMS query must not depend on application_contacts, which only
    // exists after submit. Scope to the SQL itself (not the explanatory comment,
    // which names the old approach) and guard against a regression to that join.
    const sqlStart = src.indexOf("SELECT a.id, a.contact_id, c.phone, a.silo");
    const sqlEnd = src.indexOf("LIMIT 25", sqlStart);
    const smsQuery = src.slice(sqlStart, sqlEnd);
    expect(smsQuery).not.toContain("application_contacts");
    expect(smsQuery).not.toContain("role = 'applicant'");
  });
});

describe("undeliverable numbers never reach Twilio", () => {
  it("blocks the 555-5555 placeholder that caused this", () => {
    expect(src).toContain("NOT LIKE '%5555555'");
  });

  it("blocks the NANP 555-01xx fictional range", () => {
    expect(src).toContain("NOT LIKE '%55501__'");
  });

  it("blocks short numbers", () => {
    expect(src).toContain(">= 10");
  });

  it("blocks all-identical digits", () => {
    expect(src).toContain("!~ '^(.)");
  });
});

describe("regression", () => {
  it("still only targets unsubmitted applications", () => {
    expect(src).toContain("a.submitted_at IS NULL");
  });

  it("still respects opt-out", () => {
    expect(src).toContain("COALESCE(c.sms_opt_out, false) = false");
  });

  it("still respects the CASL consent window", () => {
    expect(src).toContain("($2 || ' months')::interval");
  });

  it("still batches at 25", () => {
    expect(src).toContain("LIMIT 25");
  });
});
