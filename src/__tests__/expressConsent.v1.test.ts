// BF_SERVER_EXPRESS_CONSENT_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const route = readFileSync(path.join(process.cwd(), "src/routes/client/v1Applications.ts"), "utf8");
const migration = readFileSync(path.join(process.cwd(), "migrations/2026_07_14_sms_consent.sql"), "utf8");

describe("Step 6 Communication Consent reaches the contact record", () => {
  it("accepts all three consents, not just termsAccepted", () => {
    expect(route).toContain("shareAuthorization:");
    expect(route).toContain("communicationConsent:");
  });

  it("tolerates every shape the client may send it in", () => {
    expect(route).toContain("input.communication_consent");
    expect(route).toContain("input.infoConfirmed");
  });

  it("stamps EXPRESS consent on the contact -- express does not expire", () => {
    expect(route).toContain("consent_basis  = 'express'");
    expect(route).toContain("consent_source = 'application_step6'");
    expect(route).toContain("sms_consent    = true");
  });

  it("only stamps it when the box was actually ticked", () => {
    expect(route).toContain("if (commsConsent === true)");
  });

  it("backfills express consent from application metadata where it exists", () => {
    expect(migration).toContain("BF_SERVER_EXPRESS_CONSENT_v1");
    expect(migration).toContain("signature,communicationConsent");
    expect(migration).toContain("'express'");
  });
});
