// BF_SERVER_BLOCK_v213_BF_TO_BI_HANDOFF_v1
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildBiPayload, postBiHandoff } from "../biHandoff.js";

const ORIG_FETCH = global.fetch;

describe("BF_SERVER_BLOCK_v213_BF_TO_BI_HANDOFF_v1 — buildBiPayload", () => {
  it("maps applicant + business + kyc into the BI payload shape", () => {
    const payload = buildBiPayload({
      bfApplicationId: "bf-1",
      legacyApp: {
        applicant: {
          firstName: "Jane", lastName: "Doe",
          email: "jane@example.com", phone: "+14165551234", dob: "1980-01-01",
          street: "1 Main St", city: "Toronto", state: "ON", zip: "M5V 1A1",
        },
        business: {
          businessName: "Acme Inc",
          businessStructure: "Corporation",
          street: "2 King St", city: "Toronto", state: "ON", zip: "M5H 1A1",
        },
        kyc: {
          industry: "Manufacturing",
          fundingAmount: 250000,
          annualRevenue: 1200000,
          purposeOfFunds: "Working capital",
        },
      },
    });
    expect(payload.bf_application_id).toBe("bf-1");
    expect(payload.guarantor_name).toBe("Jane Doe");
    expect(payload.business_name).toBe("Acme Inc");
    expect(payload.loan_amount).toBe(250000);
    expect(payload.pgi_limit).toBe(200000); // 80% default
    expect(payload.naics_code).toBe("311000");
    expect(payload.naics_confidence).toBe(true);
  });

  it("flags naics_confidence=false when industry doesn't map", () => {
    const payload = buildBiPayload({
      bfApplicationId: "bf-2",
      legacyApp: { kyc: { industry: "Underwater basket weaving" } },
    });
    expect(payload.naics_code).toBeNull();
    expect(payload.naics_confidence).toBe(false);
  });
});

describe("BF_SERVER_BLOCK_v213_BF_TO_BI_HANDOFF_v1 — postBiHandoff", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-shared-secret-min-10";
    process.env.BI_SERVER_URL = "https://bi.test.local";
  });
  afterEach(() => {
    global.fetch = ORIG_FETCH;
  });

  it("returns ok=true with biPublicId + completionUrl on success", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        ok: true,
        public_id: "pub-xyz",
        application_code: "BI-ABC123",
        completion_url: "https://www.boreal.insure/login?next=/applications/pub-xyz",
      }),
      text: async () => "",
    }) as any;
    const r = await postBiHandoff({ bfApplicationId: "bf-1", legacyApp: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.biPublicId).toBe("pub-xyz");
      expect(r.completionUrl).toMatch(/^https:\/\/www\.boreal\.insure/);
    }
  });

  it("returns ok=false when BI responds non-2xx", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({}), text: async () => "boom",
    }) as any;
    const r = await postBiHandoff({ bfApplicationId: "bf-1", legacyApp: {} });
    expect(r.ok).toBe(false);
  });

  it("returns ok=false when JWT_SECRET is missing", async () => {
    delete process.env.JWT_SECRET;
    const r = await postBiHandoff({ bfApplicationId: "bf-1", legacyApp: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("no_jwt_secret");
  });
});
