// BF_SERVER_ABANDON_SMS_TARGET_v120
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "..", "abandonedApplicationWorker.ts"), "utf-8");

describe("recipient", () => {
  it("no longer uses the business contact", () => {
    expect(src).not.toContain("JOIN contacts c ON c.id = a.contact_id");
  });

  it("resolves the applicant the same way the portal does", () => {
    expect(src).toContain("FROM application_contacts");
    expect(src).toContain("role = 'applicant'");
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
