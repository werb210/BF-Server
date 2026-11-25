// BF_SERVER_SHARED_CONTACTS_v1 - routing, list parsing and the silo fan-out of the shared contact list.
import { describe, expect, it, vi } from "vitest";
import { brandsFor, consentFor, defaultBrands, domainOf, importSharedList, toRows } from "../directory/sharedContacts.js";

describe("default routing", () => {
  it("sends brokers and lenders to the silos in the design", () => {
    expect(defaultBrands("broker", "CA", "AB")).toEqual(["KS", "BI"]);
    expect(defaultBrands("broker", "US", "TX")).toEqual(["KS", "BI"]);
    expect(defaultBrands("lender", "CA", "ON")).toEqual(["BI", "BF"]);
    expect(defaultBrands("bank", "US", "NY")).toEqual(["BI", "BF"]);
  });
  it("keeps Quebec out of PGI", () => {
    expect(defaultBrands("broker", "CA", "QC")).toEqual(["KS"]);
    expect(defaultBrands("lender", "CA", "Quebec")).toEqual(["BF"]);
  });
  it("a list override only narrows the default", () => {
    expect(brandsFor("broker", "US", "TX", ["BI"])).toEqual(["BI"]);
    expect(brandsFor("bank", "US", "NY", ["KS"])).toEqual([]);
    expect(brandsFor("bank", "US", "NY", ["BF"])).toEqual(["BF"]);
  });
  it("records the consent basis for the country", () => {
    expect(consentFor("CA", "L")?.consent_type).toBe("implied_publication");
    expect(consentFor("US", "L")?.consent_type).toBe("us_opt_out");
    expect(consentFor(null, "L")).toBeNull();
  });
});

describe("list parsing", () => {
  it("makes one row per person and one per firm with nobody named", () => {
    const { rows, skipped } = toRows(
      [{ name: "Live Oak Bank", website: "https://www.liveoakbank.com", address_country: "US", address_state: "NC" }, { name: "Chase", address_country: "USA" }],
      [{ name: "Chris Maurer", company_name: "Live Oak Bank", email: "Chris.Maurer@liveoak.bank" }, { name: "X", company_name: "Live Oak Bank", email: "not-an-email" }],
      "bank",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ company: "Live Oak Bank", domain: "liveoakbank.com", country: "US", kind: "bank" });
    expect(rows[0]!.person?.email).toBe("chris.maurer@liveoak.bank");
    expect(rows[1]).toMatchObject({ company: "Chase", country: "US", person: null });
    expect(skipped).toEqual([{ row: 2, error: '"not-an-email" is not an email address.' }]);
  });
  it("takes the domain from the website, else a work email", () => {
    expect(domainOf("http://www.abc.ca/x")).toBe("abc.ca");
    expect(domainOf("", "a@firm.com")).toBe("firm.com");
    expect(domainOf("", "a@gmail.com")).toBeNull();
  });
});

describe("loading a list", () => {
  // The database answers by SQL content, not call order.
  function fakeDb() {
    const calls: string[] = [];
    let n = 0;
    return {
      calls,
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (/^\s*SELECT id FROM (directory_orgs|directory_people|contacts|companies)/.test(sql)) return { rows: [] };
        if (/INSERT INTO (directory_orgs|directory_people|contacts|companies)/.test(sql)) return { rows: [{ id: `id-${++n}` }] };
        return { rows: [] };
      }),
    };
  }
  it("fills PGI and Keystone (no brokers in the Boreal Financial CRM), and records where each person went", async () => {
    const db = fakeDb();
    const fetch = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (url.endsWith("/auth/exchange") ? { token: "ops" } : { ok: true }),
    }));
    const out = await importSharedList(db as any, { fetch, biUrl: "https://bi", ksOpsUrl: "https://ks", staffToken: "bf" }, {
      list_name: "Broker list Nov 2026", kind: "broker", only: null, created_by: "u1",
      companies: [{ name: "Chosen Capital", website: "chosencapital.ca", address_country: "Canada", address_state: "AB" }],
      contacts: [{ name: "Evan Sinclair", company_name: "Chosen Capital", email: "evan@chosencapital.ca" }],
    });
    expect(out).toMatchObject({ rows: 1, firms: 1, people_added: 1, routed: { KS: 1, BI: 1, BF: 0 } });
    const urls = fetch.mock.calls.map((c) => c[0]);
    expect(urls).toEqual(["https://bi/api/v1/bi/crm/list-import", "https://ks/api/ops/auth/exchange", "https://ks/api/ops/outreach/import"]);
    const ksBody = JSON.parse((fetch.mock.calls[2] as any)[1].body);
    expect(ksBody.consent.consent_type).toBe("implied_publication");
    expect(db.calls.filter((s) => s.includes("INSERT INTO directory_brand_status"))).toHaveLength(2);
    expect(db.calls.some((s) => s.includes("INSERT INTO directory_imports"))).toBe(true);
    // BF_SERVER_KS_CRM_FROM_LISTS_v1 - the firm and the person also land in the KS CRM; nothing in the BF CRM.
    expect(db.calls.filter((s) => /INSERT INTO companies[\s\S]*'KS'\)/.test(s))).toHaveLength(1);
    expect(db.calls.filter((s) => /INSERT INTO contacts[\s\S]*'KS', 'other'/.test(s))).toHaveLength(1);
    expect(db.calls.some((s) => /INSERT INTO contacts[\s\S]*'BF', 'other'/.test(s))).toBe(false);
    expect((out as any).ks_crm).toEqual({ people: 1, errors: 0 });
  });
  it("keeps going when one silo fails, and says which", async () => {
    const db = fakeDb();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn(async (url: string) => ({ ok: !url.includes("/bi/"), status: url.includes("/bi/") ? 500 : 200, json: async () => ({ token: "ops" }) }));
    const out: any = await importSharedList(db as any, { fetch, biUrl: "https://x/bi/", ksOpsUrl: "https://ks", staffToken: "bf" }, {
      list_name: "L", kind: "broker", only: null, created_by: null,
      companies: [], contacts: [{ name: "A B", company_name: "Firm", email: "a@firm.com", address_country: "US" }],
    });
    expect(out.silos.BI.error).toMatch(/500/);
    expect(out.silos.KS.sent).toBe(1);
    expect(err).toHaveBeenCalled();
  });
});

// BF_SHARED_CONTACTS_STAGE3_v1
describe("import preview", () => {
  it("counts new versus on file and the routing, and writes nothing", async () => {
    const { previewSharedList } = await import("../directory/sharedContacts.js");
    const calls: string[] = [];
    const db = { query: vi.fn(async (sql: string) => { calls.push(sql); return /FROM directory_people/.test(sql) ? { rows: [{ email: "evan@chosencapital.ca" }] } : { rows: [] }; }) };
    const out = await previewSharedList(db as any, {
      list_name: "L", kind: "broker", only: null,
      companies: [{ name: "Chosen Capital", website: "chosencapital.ca", address_country: "Canada", address_state: "AB" }, { name: "Laval Leasing", address_country: "CA", address_state: "QC" }],
      contacts: [
        { name: "Evan", company_name: "Chosen Capital", email: "evan@chosencapital.ca" },
        { name: "Nora", company_name: "Chosen Capital", email: "nora@chosencapital.ca" },
        { name: "Luc", company_name: "Laval Leasing", email: "luc@laval.example" },
      ],
    });
    expect(out).toMatchObject({ rows: 3, with_email: 3, people_new: 2, people_on_file: 1, routed: { KS: 3, BI: 2, BF: 0 } });
    expect(calls.every((s) => !/INSERT|UPDATE/.test(s))).toBe(true);
  });
});
