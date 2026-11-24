// BF_SHARED_CONTACTS_STAGE2_v1 - reading the silos into the shared contact list.
import { describe, expect, it, vi } from "vitest";
import { absorb, fromBi, fromKs, syncFromSilos } from "../directory/siloSync.js";

function fakeDb() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let n = 0;
  return {
    calls,
    query: vi.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/^\s*SELECT id FROM (directory_orgs|directory_people)/.test(sql)) return { rows: [] };
      if (/INSERT INTO (directory_orgs|directory_people)/.test(sql)) return { rows: [{ id: `id-${++n}` }] };
      return { rows: [] };
    }),
  };
}

const BI_ITEMS = [
  { id: "b1", full_name: "Lou Lender", email: "Lou@Prairie.example", phone_e164: "+14035550101", title: "VP", company: "Prairie Credit", website: "prairie.example", country: "CA", state: "AB", kind: "lender", opted_out: false, outreach_status: "contacted" },
  { id: "b2", full_name: "Una Unsub", email: "una@bank.example", country: "US", state: "TX", kind: "bank", opted_out: true },
  { id: "b3", full_name: "No Email", email: null, kind: "broker" },
];

describe("silo records into shared-list people", () => {
  it("maps BI and Keystone records", () => {
    expect(fromBi(BI_ITEMS[0])).toMatchObject({ email: "lou@prairie.example", kind: "lender", country: "CA", region: "AB", activity: "contacted", opted_out: false });
    expect(fromKs({ id: "k1", name: "Bea", email: "bea@b.example", country: "United States", province_state: "TX", status: "lead", opted_out: true }))
      .toMatchObject({ kind: "broker", country: "US", opted_out: true, activity: "lead" });
  });
  it("skips people with no email; an opt-out in the silo is recorded for that brand", async () => {
    const db = fakeDb();
    expect(await absorb(db as any, "BI", fromBi(BI_ITEMS[2]), "BI CRM")).toBe("skipped");
    expect(await absorb(db as any, "BI", fromBi(BI_ITEMS[1]), "BI CRM")).toBe("added");
    const status = db.calls.find((c) => c.sql.includes("INSERT INTO directory_brand_status"))!;
    expect(status.params.slice(1, 4)).toEqual(["BI", "opted_out", "b2"]);
    expect(status.sql).toMatch(/directory_brand_status\.status = 'opted_out' OR EXCLUDED\.status = 'opted_out'/);
  });
});

describe("syncFromSilos", () => {
  it("pages through BI with a service token; Keystone waits for a staff sign-in; the run is logged", async () => {
    const db = fakeDb();
    const fetch = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (url.includes("after=b2") ? { items: [BI_ITEMS[2]], next: null } : { items: BI_ITEMS.slice(0, 2), next: "b2" }),
    }));
    const out = await syncFromSilos(db as any, { fetch, biUrl: "https://bi", ksOpsUrl: "https://ks", staffToken: null }, "nightly");
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://bi/api/v1/bi/crm/directory-export?limit=1000",
      "https://bi/api/v1/bi/crm/directory-export?limit=1000&after=b2",
    ]);
    expect((fetch.mock.calls[0] as any)[1].headers.authorization).toMatch(/^Bearer /);
    expect(out.results[0]).toMatchObject({ brand: "BI", read: 3, people_added: 2, skipped: 1 });
    expect(out.results[1]).toMatchObject({ brand: "KS", read: 0 });
    expect(out.results[1]!.error).toMatch(/staff/);
    expect(db.calls.some((c) => c.sql.includes("INSERT INTO directory_imports") && c.sql.includes("'sync'"))).toBe(true);
  });
  it("with a staff sign-in, Keystone is read through the KS-Ops exchange", async () => {
    const db = fakeDb();
    const fetch = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (url.endsWith("/auth/exchange") ? { token: "ops" }
        : url.includes("/outreach/") ? { items: [{ id: "k1", name: "Bea", email: "bea@b.example", country: "CA", status: "lead" }], next: null }
        : { items: [], next: null }),
    }));
    const out = await syncFromSilos(db as any, { fetch, biUrl: "https://bi", ksOpsUrl: "https://ks", staffToken: "bf-staff" }, "u1");
    expect(out.results[1]).toMatchObject({ brand: "KS", read: 1, people_added: 1 });
    const ks = fetch.mock.calls.find((c) => String(c[0]).includes("/outreach/directory-export"))!;
    expect((ks as any)[1].headers.authorization).toBe("Bearer ops");
  });
  it("one silo failing doesn't stop the other", async () => {
    const db = fakeDb();
    const fetch = vi.fn(async (url: string) => (url.startsWith("https://bi") ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => (url.endsWith("/auth/exchange") ? { token: "ops" } : { items: [], next: null }) }));
    const out = await syncFromSilos(db as any, { fetch, biUrl: "https://bi", ksOpsUrl: "https://ks", staffToken: "t" }, "u1");
    expect(out.results[0]!.error).toMatch(/503/);
    expect(out.results[1]!.error).toBeUndefined();
  });
});
