// BF_SERVER_BI_HANDOFF_FIELDS_v281
import { describe, expect, it } from "vitest";
import { amountFromBand, buildBiPayload, toE164 } from "../biHandoff.js";

describe("what BF-client really submits", () => {
  const payload = buildBiPayload({
    bfApplicationId: "bf-9",
    legacyApp: {
      applicant: { firstName: "Luis", lastName: "De La Torre", email: "l@example.com", phone: "(780) 916-7413", dob: "1981-02-03", street: "1 Jasper Ave", city: "Edmonton", state: "AB", zip: "T5J 1A1" },
      business: { legalName: "EllisDon Events Inc", businessStructure: "Corporation", address: "10 Main St", city: "Edmonton", state: "AB", zip: "T5J 2B2", craBusinessNumber: "123456789", startDate: "2015-06", naicsCode: "711310" },
      kyc: { industry: "Hospitality & Lodging", fundingAmount: "250,000", annualRevenue: "$500,001 to $1,000,000", availableCollateral: "$100,001 to $250,000", purposeOfFunds: "Working capital" },
    },
  });
  it("sends the phone in the E.164 form BI signs applicants in with", () => {
    expect(payload.guarantor_phone).toBe("+17809167413");
  });
  it("fills revenue, collateral, business number and the NAICS code the applicant picked", () => {
    expect(payload.annual_revenue).toBe(750001);
    expect(payload.collateral_value).toBe(175001);
    expect(payload.business_number).toBe("123456789");
    expect(payload.naics_code).toBe("711310");
    expect(payload.naics_confidence).toBe(true);
    expect(payload.business_name).toBe("EllisDon Events Inc");
    expect(payload.loan_amount).toBe(250000);
  });
  it("maps Step 1 industries when no NAICS was picked", () => {
    const p = buildBiPayload({ bfApplicationId: "x", legacyApp: { kyc: { industry: "Logistics & Trucking" } } });
    expect(p.naics_code).toBe("484000");
  });
});

describe("helpers", () => {
  it("normalises North American phone numbers and leaves junk out", () => {
    expect(toE164("780-916-7413")).toBe("+17809167413");
    expect(toE164("1 (780) 916-7413")).toBe("+17809167413");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164("12345")).toBeNull();
  });
  it("reads dropdown bands", () => {
    expect(amountFromBand("Zero to $150,000")).toBe(75000);
    expect(amountFromBand("Over $3,000,000")).toBe(3000000);
    expect(amountFromBand("$500,001 to $1 million")).toBe(750001);
    expect(amountFromBand("No Collateral Available")).toBeNull();
  });
});
