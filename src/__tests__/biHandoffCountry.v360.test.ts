// BF_SERVER_BI_HANDOFF_COUNTRY_v360
import { describe, it, expect } from "vitest";
import { buildBiPayload, countryOf } from "../services/biHandoff.js";

describe("BI handoff carries country and website", () => {
  it("reads the wizard's business location", () => {
    expect(countryOf("Canada")).toBe("CA");
    expect(countryOf("United States")).toBe("US");
    expect(countryOf("USA")).toBe("US");
    expect(countryOf("Other")).toBeNull();
  });
  it("puts country and website on the payload", () => {
    const p = buildBiPayload({
      bfApplicationId: "bf-1",
      legacyApp: { kyc: { businessLocation: "United States" }, business: { website: "https://gym.example" } },
    });
    expect(p.country).toBe("US");
    expect(p.business_website).toBe("https://gym.example");
  });
  it("falls back to the normalized company country", () => {
    const p = buildBiPayload({ bfApplicationId: "bf-2", legacyApp: {}, normalized: { company: { address_country: "CA" } } });
    expect(p.country).toBe("CA");
  });
});
