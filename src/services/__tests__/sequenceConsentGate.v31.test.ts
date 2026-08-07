// BF_SERVER_SEQUENCE_CONSENT_GATE_v31
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { hasSmsConsent } from "../sequenceEngine.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe("hasSmsConsent", () => {
  it("accepts express consent regardless of age", () => {
    expect(hasSmsConsent({ sms_consent: true, consent_at: daysAgo(5000) })).toBe(true);
  });

  it("rejects a contact who merely never opted out", () => {
    expect(hasSmsConsent({ sms_consent: false, consent_basis: null, consent_at: null })).toBe(false);
  });

  it("accepts implied_transaction inside 2 years and rejects outside", () => {
    expect(hasSmsConsent({ consent_basis: "implied_transaction", consent_at: daysAgo(700) })).toBe(true);
    expect(hasSmsConsent({ consent_basis: "implied_transaction", consent_at: daysAgo(800) })).toBe(false);
  });

  it("accepts implied_inquiry inside 6 months and rejects outside", () => {
    expect(hasSmsConsent({ consent_basis: "implied_inquiry", consent_at: daysAgo(100) })).toBe(true);
    expect(hasSmsConsent({ consent_basis: "implied_inquiry", consent_at: daysAgo(200) })).toBe(false);
  });

  it("rejects an unknown basis and an unparseable date", () => {
    expect(hasSmsConsent({ consent_basis: "vibes", consent_at: daysAgo(1) })).toBe(false);
    expect(hasSmsConsent({ consent_basis: "implied_inquiry", consent_at: "not-a-date" })).toBe(false);
  });
});

describe("sequenceEngine wiring", () => {
  const src = readFileSync("src/services/sequenceEngine.ts", "utf8");

  it("applies the consent test to the textable branch", () => {
    expect(src).toContain("&& hasSmsConsent(c)");
  });

  it("selects the consent columns it needs", () => {
    expect(src).toContain("COALESCE(sms_consent,false) AS sms_consent");
    expect(src).toContain("consent_basis");
    expect(src).toContain("consent_at");
  });

  it("fails closed when no audience tags are selected", () => {
    expect(src).toContain("AND cardinality($4::text[]) > 0");
    expect(src).not.toContain("cardinality($4::text[]) = 0 OR");
  });
});

describe("parity with the blast runner", () => {
  it("smsConsent.ts still defines the windows this mirrors", () => {
    const consent = readFileSync("src/services/smsConsent.ts", "utf8");
    expect(consent).toContain("implied_transaction");
    expect(consent).toContain("interval '2 years'");
    expect(consent).toContain("implied_inquiry");
    expect(consent).toContain("interval '6 months'");
  });
});
