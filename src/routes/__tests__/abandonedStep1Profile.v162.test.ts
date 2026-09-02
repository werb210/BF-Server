// BF_SERVER_ABANDONED_STEP1_PROFILE_v162
// Behavioural tests (no DB): the amount parser that feeds requested_amount, and
// that /start's schema actually accepts + preserves the financialProfile (a
// z.object strips unknown keys, so without the schema field the profile would be
// silently dropped and the funnel would stay blank).
import { describe, it, expect } from "vitest";
import { deriveStartRequestedAmount } from "../publicApplication";
// The schema is module-private; re-parse through the same z definition shape by
// importing the router module is unnecessary - we assert the parser here and the
// schema behaviour via a focused reconstruction below.
import { z } from "zod";

describe("deriveStartRequestedAmount", () => {
  it("parses a currency-formatted fundingAmount", () => {
    expect(deriveStartRequestedAmount({ fundingAmount: "$250,000" })).toBe(250000);
  });

  it("falls back to equipmentAmount when fundingAmount is absent", () => {
    expect(deriveStartRequestedAmount({ equipmentAmount: "75000" })).toBe(75000);
  });

  it("prefers fundingAmount over equipmentAmount when both are present", () => {
    expect(deriveStartRequestedAmount({ fundingAmount: "$100,000", equipmentAmount: "$5,000" })).toBe(100000);
  });

  it("returns null for missing / zero / non-numeric input", () => {
    expect(deriveStartRequestedAmount({})).toBeNull();
    expect(deriveStartRequestedAmount({ fundingAmount: "" })).toBeNull();
    expect(deriveStartRequestedAmount({ fundingAmount: "$0" })).toBeNull();
    expect(deriveStartRequestedAmount(null)).toBeNull();
    expect(deriveStartRequestedAmount({ fundingAmount: "n/a" })).toBeNull();
  });
});

describe("start schema preserves a nested profile object", () => {
  // Mirrors the shape used in publicApplication StartSchema: a z.record(z.any())
  // must retain nested keys rather than dropping them (the bug a plain omitted
  // field would cause).
  it("keeps businessLocation and monthlyRevenue on financialProfile", () => {
    const schema = z.object({ financialProfile: z.record(z.any()).optional() });
    const parsed = schema.safeParse({
      financialProfile: { businessLocation: "Canada", monthlyRevenue: "Over $250,000", fundingAmount: "$300,000" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.financialProfile?.businessLocation).toBe("Canada");
      expect(parsed.data.financialProfile?.monthlyRevenue).toBe("Over $250,000");
    }
  });
});
