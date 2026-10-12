// BF_SERVER_AD_ATTRIBUTION_v1 - server-side gclid ad attribution.
import { readFileSync } from "fs";
import { join } from "path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { mountRouter, staffToken } from "./helpers/staffRouterApp.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: queryMock }, dbQuery: queryMock }));

const CONTACT = "c0c0c0c0-0000-4000-8000-000000000001";
const ADS_ENV = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
  GOOGLE_ADS_CLIENT_ID: "cid",
  GOOGLE_ADS_CLIENT_SECRET: "secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh",
  GOOGLE_ADS_CUSTOMER_ID: "123-456-7890",
};
const CLICK = {
  segments: { date: "2026-07-07" },
  campaign: { id: 11, name: "Search CA" },
  adGroup: { id: 22, name: "Working capital" },
  clickView: { gclid: "G-1", adGroupAd: "customers/1234567890/adGroupAds/22~333", keywordInfo: { text: "business loan", matchType: "PHRASE" } },
};

let searches: string[];
function stubGoogle(search: () => Promise<Response> | Response) {
  searches = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    if (String(url).includes("googleAds:search")) {
      searches.push(String(JSON.parse(String(init?.body)).query));
      return search();
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ADS_ENV)) vi.stubEnv(k, v);
  queryMock.mockReset().mockImplementation(answerBySql([[/INSERT INTO contact_ad_attribution/, { rows: [{ inserted: false }] }]]));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ad attribution v1", () => {
  it("creates the contact_ad_attribution table", () => {
    const sql = readFileSync(join(process.cwd(), "migrations", "2026_07_07_ad_attribution.sql"), "utf-8");
    expect(sql).toContain("BF_SERVER_AD_ATTRIBUTION_v1");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS contact_ad_attribution");
    expect(sql).toContain("UNIQUE (contact_id, gclid)");
  });

  it("exports the Google Ads GAQL runner, which posts the query and pages through results", async () => {
    const { googleAdsSearch } = await import("../services/googleAdsService.js");
    let page = 0;
    stubGoogle(() => new Response(JSON.stringify(page++ === 0 ? { results: [{ a: 1 }], nextPageToken: "p2" } : { results: [{ a: 2 }] }), { status: 200 }));
    expect(await googleAdsSearch("SELECT campaign.id FROM campaign")).toEqual([{ a: 1 }, { a: 2 }]);
    expect(searches).toEqual(["SELECT campaign.id FROM campaign", "SELECT campaign.id FROM campaign"]);
  });

  it("resolves click_view rows and upserts attribution", async () => {
    const { resolveAndStoreAdAttribution } = await import("../services/googleAdsAttribution.js");
    stubGoogle(() => new Response(JSON.stringify({ results: [CLICK] }), { status: 200 }));
    await resolveAndStoreAdAttribution({ contactId: CONTACT, gclid: "G-1", occurredAt: new Date().toISOString() });
    expect(searches[0]).toContain("FROM click_view");
    expect(searches[0]).toContain("click_view.gclid = 'G-1'");
    const [upsert] = callsMatching(queryMock, /INSERT INTO contact_ad_attribution/);
    expect(String(upsert[0])).toContain("ON CONFLICT (contact_id, gclid) DO UPDATE");
    expect((upsert[1] as unknown[]).slice(0, 10)).toEqual([CONTACT, "G-1", "2026-07-07", "11", "Search CA", "22", "Working capital", "333", "business loan", "PHRASE"]);
  });

  it("never throws: a failed store is logged and swallowed", async () => {
    const { resolveAndStoreAdAttribution } = await import("../services/googleAdsAttribution.js");
    stubGoogle(() => new Response(JSON.stringify({ results: [CLICK] }), { status: 200 }));
    queryMock.mockImplementation(answerBySql([[/INSERT INTO contact_ad_attribution/, new Error("db down")]]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(resolveAndStoreAdAttribution({ contactId: CONTACT, gclid: "G-1" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[google_ads_attribution] resolve failed", "db down");
  });

  it("fires resolution from the CRM mirror without waiting on it", async () => {
    const { mirrorApplicationToCrm } = await import("../services/applicationCrmMirror.js");
    // Google never answers: the mirror must still finish.
    stubGoogle(() => new Promise<Response>(() => undefined));
    queryMock.mockImplementation(answerBySql([
      [/SELECT id, phone FROM contacts/, { rows: [{ id: CONTACT, phone: "+14035550100" }] }],
      [/information_schema\.columns/, { rows: [{ exists: true }] }],
    ]));
    await mirrorApplicationToCrm({
      applicationId: "app-1",
      silo: "BF",
      applicant: { fullName: "Ada Lead", phone: "+14035550100" },
      attribution: { gclid: "G-MIRROR", utm_source: "google", capturedAt: new Date().toISOString() },
    });
    await vi.waitFor(() => expect(searches.length).toBeGreaterThan(0));
    expect(searches[0]).toContain("click_view.gclid = 'G-MIRROR'");
  });

  it("exposes the CRM route, reading contact_ad_attribution for the contact", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM contact_ad_attribution/, { rows: [{ campaign_name: "Search CA", keyword_text: "business loan", gclid: "G-1" }] }],
    ]));
    const router = (await import("../routes/crm.js")).default;
    const res = await request(mountRouter(router, "/api/crm")).get(`/api/crm/contacts/${CONTACT}/ad-attribution`).set("Authorization", `Bearer ${staffToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.ad).toEqual({ source: "google_ads", resolved: true, campaign_name: "Search CA", keyword_text: "business loan", gclid: "G-1" });
    expect(callsMatching(queryMock, /FROM contact_ad_attribution/)[0][1]).toEqual([CONTACT]);
  });
});
