// BF_SERVER_v897_FREE_IP_CHECK
import { describe, expect, it } from "vitest";
import { parseRdapIp, rdapIpProvider } from "../providers/lookups.js";
import { fraudProviders } from "../providers/index.js";

const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

describe("keyless IP check (RDAP)", () => {
  it("reads country and owner, and flags data-centre networks", () => {
    const dc = parseRdapIp({ country: "us", name: "AMAZON-IAD", entities: [{ vcardArray: ["vcard", [["fn", {}, "text", "Amazon Technologies Inc."]]] }] });
    expect(dc.country).toBe("US");
    expect(dc.hosting).toBe(true);
    expect(dc.vpn).toBeNull();
    const home = parseRdapIp({ country: "CA", name: "TELUS-ADSL", entities: [{ vcardArray: ["vcard", [["fn", {}, "text", "TELUS Communications Inc."]]] }] });
    expect(home.country).toBe("CA");
    expect(home.hosting).toBeNull();
    expect(home.asnOrg).toBe("TELUS Communications Inc.");
  });

  it("is used when IPINFO_TOKEN is not set, and ipinfo when it is", () => {
    expect(fraudProviders({ NODE_ENV: "test" } as any, ok({}) as any).ipIntel.name).toBe("rdap");
    expect(fraudProviders({ NODE_ENV: "test", IPINFO_TOKEN: "t" } as any, ok({}) as any).ipIntel.name).toBe("ipinfo");
  });

  it("looks up through rdap.org and can be turned off", async () => {
    const p = rdapIpProvider({ NODE_ENV: "test" } as any, ok({ country: "CA", name: "X" }) as any);
    expect(p.configured()).toBe(true);
    expect(await p.lookup("203.0.113.5")).toMatchObject({ ok: true, country: "CA" });
    expect(rdapIpProvider({ NODE_ENV: "test", FRAUD_RDAP: "off" } as any, ok({}) as any).configured()).toBe(false);
  });
});

import { addressProvider, parseNominatim } from "../providers/lookups.js";

describe("keyless address check (OpenStreetMap)", () => {
  it("is the default without a Google key", () => {
    expect(addressProvider({ NODE_ENV: "test" } as any, ok([]) as any).name).toBe("openstreetmap");
    expect(addressProvider({ NODE_ENV: "test", GOOGLE_PLACES_API_KEY: "k" } as any, ok({}) as any).name).toBe("google");
  });
  it("confirms a building-level match and keeps mail drops from the list", () => {
    expect(parseNominatim([{ addresstype: "building", display_name: "100 Test Ave" }], "100 Test Ave")?.kind).toBe("street");
    expect(parseNominatim([{ addresstype: "road", address: {} }], "Test Ave")?.kind).toBe("unknown");
    expect(parseNominatim([], "Nowhere")?.matched).toBe("not found");
    expect(parseNominatim([{ addresstype: "building" }], "The UPS Store 55, 9 Test Rd")?.kind).toBe("mail_drop");
  });
});
