// BF_SERVER_v893_ADDRESS_VALIDATION
import { describe, expect, it } from "vitest";
import { addressProvider, parseGoogleAddressValidation } from "../providers/lookups.js";

const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

describe("Google address validation", () => {
  it("is off without a key and when FRAUD_ADDRESS_PROVIDER=list", () => {
    expect(addressProvider({ NODE_ENV: "test" } as any, ok({}) as any).name).toBe("openstreetmap"); // v897: no Google key -> OpenStreetMap
    expect(addressProvider({ NODE_ENV: "test", GOOGLE_PLACES_API_KEY: "k", FRAUD_ADDRESS_PROVIDER: "list" } as any, ok({}) as any).configured()).toBe(false);
    expect(addressProvider({ NODE_ENV: "test", GOOGLE_PLACES_API_KEY: "k" } as any, ok({}) as any).configured()).toBe(true);
  });

  it("never reaches the network in tests without a fetch of its own", async () => {
    expect(await addressProvider({ NODE_ENV: "test", GOOGLE_PLACES_API_KEY: "k" } as any).classify("1 Main St")).toBeNull();
  });

  it("confirms a complete premise-level address as a street address", async () => {
    const body = { result: { verdict: { validationGranularity: "PREMISE", addressComplete: true }, address: { formattedAddress: "100 Test Ave, Calgary AB" }, metadata: {} } };
    const r = await addressProvider({ NODE_ENV: "test", GOOGLE_PLACES_API_KEY: "k" } as any, ok(body) as any).classify("100 Test Ave, Calgary AB");
    expect(r).toEqual({ kind: "street", matched: "100 Test Ave, Calgary AB", source: "google" });
  });

  it("flags a PO box from Google and keeps the list's mail-drop match", () => {
    expect(parseGoogleAddressValidation({ result: { metadata: { poBox: true }, verdict: {} } }, "Box 12, Town")?.kind).toBe("po_box");
    expect(parseGoogleAddressValidation({ result: { verdict: { validationGranularity: "PREMISE", addressComplete: true } } }, "The UPS Store 55, 9 Test Rd")?.kind).toBe("mail_drop");
  });

  it("reports an unconfirmed address as unknown, and an error as null so the list is used", async () => {
    expect(parseGoogleAddressValidation({ result: { verdict: { validationGranularity: "ROUTE" } } }, "Somewhere")?.kind).toBe("unknown");
    const bad = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "" });
    expect(await addressProvider({ NODE_ENV: "test", GOOGLE_PLACES_API_KEY: "k" } as any, bad as any).classify("1 Main St")).toBeNull();
  });
});
