import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { mountRouter, staffToken } from "./helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  ingest: vi.fn(),
  // When set, the worker's other stages answer a marker instead of doing real work.
  stubStages: false,
}));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query }));
// No importActual here: googleDataManager and googleAdsConversions import each other.
vi.mock("../services/googleDataManager.js", () => ({
  ingestConversions: h.ingest,
  commissionRate: () => 0.02,
}));
vi.mock("../services/googleAdsConversions.js", async () => {
  const a = await vi.importActual<any>("../services/googleAdsConversions.js");
  return {
    ...a,
    uploadSubmitConversions: vi.fn((...x: unknown[]) => (h.stubStages ? Promise.resolve({ stage: "submit" }) : a.uploadSubmitConversions(...x))),
    uploadFundedConversions: vi.fn((...x: unknown[]) => (h.stubStages ? Promise.resolve({ stage: "funded" }) : a.uploadFundedConversions(...x))),
  };
});
vi.mock("../services/googleAdsLeadSignals.js", async () => {
  const a = await vi.importActual<any>("../services/googleAdsLeadSignals.js");
  return {
    ...a,
    uploadQualifiedConversions: vi.fn((...x: unknown[]) => (h.stubStages ? Promise.resolve({ stage: "qualified" }) : a.uploadQualifiedConversions(...x))),
    retractClosedSubmitConversions: vi.fn((...x: unknown[]) => (h.stubStages ? Promise.resolve({ stage: "retracted" }) : a.retractClosedSubmitConversions(...x))),
  };
});
vi.mock("../services/googleAdsEnhanced.js", async () => ({
  ...(await vi.importActual<any>("../services/googleAdsEnhanced.js")),
  syncCustomerMatch: vi.fn(async () => ({ stage: "customerMatch" })),
}));
vi.mock("../services/googleHealth.js", () => ({ startGoogleHealthMonitor: () => ({ stop: () => undefined }) }));
vi.mock("../services/googleAudienceSync.js", () => ({ syncAudiencesViaDataManager: async () => ({}) }));
vi.mock("../services/visitorAdLookup.js", () => ({ resolveVisitorSessionAds: async () => ({ tried: 0, resolved: 0 }) }));
vi.mock("../services/customerMatchLists.js", () => ({ syncFundedList: async () => ({}) }));
vi.mock("../workers/claim.js", () => ({ claimedTick: (_name: string, fn: () => Promise<unknown>) => fn }));

import { CLOSED_STATES, QUALIFIED_STATES, qualifiedPayload, retractionPayload } from "../services/googleAdsLeadSignals.js";

const ADS_ENV = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
  GOOGLE_ADS_CLIENT_ID: "cid",
  GOOGLE_ADS_CLIENT_SECRET: "secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh",
  GOOGLE_ADS_CUSTOMER_ID: "1234567890",
};
const CONTACT = "c0c0c0c0-0000-4000-8000-000000000002";

let searches: string[];
function stubGoogle(search: () => Response) {
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
  h.query.mockReset().mockImplementation(answerBySql([]));
  h.ingest.mockReset().mockResolvedValue({ ok: true, status: 200, detail: "" });
  h.stubStages = false;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Google Ads attribution", () => {
  it("queries fields supported by click_view", async () => {
    const { queryClick } = await import("../services/googleAdsAttribution.js");
    stubGoogle(() => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    await queryClick("G-1", "2026-09-22");
    const query = searches[0];
    const fields = query.slice(query.indexOf("click_view.gclid,"), query.indexOf("FROM click_view"));
    expect(fields).toContain("click_view.keyword_info.text");
    expect(fields).toContain("click_view.ad_group_ad");
    expect(fields).not.toContain("ad_group_criterion");
    expect(fields).not.toContain("ad_group_ad.ad.id");
  });

  it("logs query failures", async () => {
    const { resolveAndStoreAdAttribution } = await import("../services/googleAdsAttribution.js");
    stubGoogle(() => new Response("bad field", { status: 400 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await resolveAndStoreAdAttribution({ contactId: CONTACT, gclid: "G-2" });
    expect(warn).toHaveBeenCalledWith("[google_ads_attribution] click_view query failed", expect.stringContaining("google_ads_search status=400"));
    expect(callsMatching(h.query, /INSERT INTO contact_ad_attribution/)).toHaveLength(0);
  });

  it("retries unresolved draft clicks", async () => {
    const { resolvePendingAdAttributions } = await import("../services/googleAdsAttribution.js");
    stubGoogle(() => new Response(JSON.stringify({ results: [{ segments: { date: "2026-09-22" }, clickView: { gclid: "G-3" } }] }), { status: 200 }));
    h.query.mockImplementation(answerBySql([
      [/NOT EXISTS \(SELECT 1 FROM contact_ad_attribution/, { rows: [{ contact_id: CONTACT, application_id: "draft-1", gclid: "G-3", at: new Date().toISOString() }] }],
      [/INSERT INTO contact_ad_attribution/, { rows: [{ inserted: false }] }],
      [/count\(DISTINCT contact_id\)/, { rows: [{ n: 1 }] }],
    ]));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await resolvePendingAdAttributions()).toEqual({ tried: 1, resolved: 1 });
    const [pending] = callsMatching(h.query, /NOT EXISTS \(SELECT 1 FROM contact_ad_attribution/);
    // Drafts count: the pending pass does not require a submitted application.
    expect(String(pending[0])).not.toContain("submitted_at");
    expect(callsMatching(h.query, /INSERT INTO contact_ad_attribution/)[0][1]).toEqual(expect.arrayContaining([CONTACT, "G-3"]));
  });

  describe("contact card route", () => {
    const get = async () => {
      const router = (await import("../routes/crm.js")).default;
      return request(mountRouter(router, "/api/crm")).get(`/api/crm/contacts/${CONTACT}/ad-attribution`).set("Authorization", `Bearer ${staffToken()}`);
    };

    it("returns the contact-card shape for a resolved click", async () => {
      const utm = { gclid: "G-1", utm_source: "google" };
      h.query.mockImplementation(answerBySql([
        [/FROM contact_ad_attribution/, { rows: [{ campaign_name: "Search", keyword_text: "loans", gclid: "G-1" }] }],
        [/AS payload/, { rows: [{ payload: utm }] }],
      ]));
      const res = await get();
      expect(res.body).toEqual({ ok: true, data: { ad: { source: "google_ads", resolved: true, campaign_name: "Search", keyword_text: "loans", gclid: "G-1" }, utm } });
      expect(String(callsMatching(h.query, /FROM contact_ad_attribution/)[0][0])).toContain("keyword AS keyword_text");
    });

    it("includes attribution from drafts (applications.metadata) when nothing is resolved yet", async () => {
      const utm = { gbraid: "B-1", capturedAt: "2026-09-20T00:00:00Z" };
      h.query.mockImplementation(answerBySql([[/AS payload/, { rows: [{ payload: utm }] }]]));
      const res = await get();
      expect(res.body.data).toEqual({ ad: { source: "google_ads", resolved: false, click_date: "2026-09-20T00:00:00Z" }, utm });
      expect(String(callsMatching(h.query, /AS payload/)[0][0])).toContain("application.metadata->'attribution' AS payload");
    });
  });
});

describe("Google Ads click identifiers", () => {
  it("uses gbraid and wbraid for submitted and funded uploads", async () => {
    vi.stubEnv("GOOGLE_ADS_SUBMIT_CONVERSION_ACTION_ID", "111");
    vi.stubEnv("GOOGLE_ADS_CONVERSION_ACTION_ID", "222");
    const { uploadSubmitConversions, uploadFundedConversions } = await import("../services/googleAdsConversions.js");
    h.query.mockImplementation(answerBySql([
      [/submitted_at IS NOT NULL/, { rows: [{ id: "s1", gclid: "BRAID-S", click_field: "gbraid", value: "1000", submitted_at: "2026-09-22T10:00:00Z" }] }],
      [/pipeline_state = ANY\(\$1\)/, { rows: [{ id: "f1", gclid: "BRAID-F", click_field: "wbraid", value: "2000", funded_at: "2026-09-22T10:00:00Z" }] }],
    ]));
    expect(await uploadSubmitConversions()).toMatchObject({ uploaded: 1 });
    expect(await uploadFundedConversions()).toMatchObject({ uploaded: 1 });
    const sent = h.ingest.mock.calls.map((c) => c[1][0]);
    expect(sent).toEqual([
      expect.objectContaining({ transactionId: "s1-submit", clickField: "gbraid", clickId: "BRAID-S" }),
      expect.objectContaining({ transactionId: "f1", clickField: "wbraid", clickId: "BRAID-F" }),
    ]);
    // Both pending queries derive the click field from gclid, then gbraid, then wbraid.
    for (const pattern of [/submitted_at IS NOT NULL/, /pipeline_state = ANY\(\$1\)/]) {
      expect(String(callsMatching(h.query, pattern)[0][0])).toContain("CASE WHEN COALESCE(metadata->'attribution'->>'gclid','') <> '' THEN 'gclid' WHEN COALESCE(metadata->'attribution'->>'gbraid','') <> '' THEN 'gbraid' ELSE 'wbraid' END");
    }
  });

  it("uses the selected click-id field in qualified payloads", () => {
    const body: any = qualifiedPayload({ applicationId: "a1", clickId: "BRAID", clickField: "gbraid", value: 50_000, at: "2026-09-22T10:00:00Z" }, "123", "456", "CAD");
    expect(body.conversions[0].gbraid).toBe("BRAID");
    expect(body.conversions[0].gclid).toBeUndefined();
    expect(body.conversions[0].orderId).toBe("a1-qualified");
    expect(body.conversions[0].conversionAction).toBe("customers/123/conversionActions/456");
  });
});

describe("Google Ads lead-quality signals", () => {
  it("defines qualified and closed states", () => {
    expect(QUALIFIED_STATES).toEqual(["off to lender", "offer", "accepted", "funded"]);
    expect(CLOSED_STATES).toEqual(["rejected", "declined", "withdrawn", "closed"]);
  });

  it("retracts submitted conversions by order id", () => {
    const body: any = retractionPayload(["a9"], "123", "777", new Date("2026-09-22T12:00:00Z"));
    expect(body.conversionAdjustments[0]).toEqual({
      conversionAction: "customers/123/conversionActions/777",
      adjustmentType: "RETRACTION",
      orderId: "a9-submit",
      adjustmentDateTime: "2026-09-22 12:00:00+00:00",
    });
  });

  it("runs signals and the attribution retry hourly", async () => {
    h.stubStages = true;
    const intervals: number[] = [];
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
      intervals.push(Number(ms));
      return realSetInterval(fn, 1e9);
    }) as any);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { startAdConversionWorker } = await import("../workers/adConversionWorker.js");
    const worker = startAdConversionWorker({} as any);
    try {
      await vi.waitFor(() => expect(log.mock.calls.some((c) => c[0] === "[ads_conversion] tick")).toBe(true));
      const line = JSON.parse(String(log.mock.calls.find((c) => c[0] === "[ads_conversion] tick")![1]));
      expect(line.qualified).toEqual({ stage: "qualified" });
      expect(line.retracted).toEqual({ stage: "retracted" });
      // The real attribution retry ran against the database.
      expect(line.attribution).toEqual({ tried: 0, resolved: 0 });
      expect(callsMatching(h.query, /NOT EXISTS \(SELECT 1 FROM contact_ad_attribution/)).toHaveLength(1);
      expect(intervals).toContain(60 * 60_000);
    } finally {
      worker.stop();
    }
  });

  it("exposes status", async () => {
    h.query.mockImplementation(answerBySql([[/AS submit_sent/, { rows: [{ submit_sent: "3", qualified_waiting: "2" }] }]]));
    const router = (await import("../routes/marketing.js")).default;
    const res = await request(mountRouter(router, "/api/marketing")).get("/api/marketing/google-ads/conversions/status").set("Authorization", `Bearer ${staffToken()}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('"submitted":{"configured":false,"sent":3');
  });
});
