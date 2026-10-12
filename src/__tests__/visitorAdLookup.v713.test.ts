// BF_SERVER_VISITOR_AD_LOOKUP_v713
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const queries: Array<{ sql: string; params: unknown[] }> = [];
let pending: any[] = [];
vi.mock("../db.js", () => ({ pool: { query: vi.fn(async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return /FROM visitor_sessions/.test(sql) && /SELECT/.test(sql) ? { rows: pending } : { rows: [] }; }) } }));
vi.mock("../services/googleAdsService.js", () => ({ googleAdsConfigured: () => true, googleAdsSearch: vi.fn() }));
vi.mock("../observability/logger.js", () => ({ logError: vi.fn() }));
// The worker's own scheduling: run the tick body directly, no Google health timers.
vi.mock("../workers/claim.js", async (orig) => ({ ...(await orig<typeof import("../workers/claim.js")>()), claimedTick: (_name: string, fn: () => Promise<void>) => fn }));
vi.mock("../services/googleHealth.js", async (orig) => ({ ...(await orig<typeof import("../services/googleHealth.js")>()), startGoogleHealthMonitor: () => ({ stop: () => undefined }) }));
vi.mock("../services/visitorAdLookup.js", async (orig) => {
  const real = await orig<typeof import("../services/visitorAdLookup.js")>();
  const { vi: v } = await import("vitest");
  return { ...real, resolveVisitorSessionAds: v.fn(real.resolveVisitorSessionAds) };
});
import { resolveVisitorSessionAds } from "../services/visitorAdLookup.js";

beforeEach(() => { queries.length = 0; pending = []; });

describe("campaign and keyword for every ad visit", () => {
  it("looks up anonymous ad visits in Google and stores campaign, ad group and keyword on the visit", async () => {
    pending = [{ session_id: "s1", gclid: "g1", first_seen_at: new Date().toISOString() }, { session_id: "s2", gclid: "g2", first_seen_at: new Date().toISOString() }];
    const lookup = vi.fn(async (gclid: string) => (gclid === "g1" ? { campaign: { name: "BF Search" }, adGroup: { name: "SBA" }, clickView: { keywordInfo: { text: "sba loan" } }, segments: { date: "2026-10-02" } } : null));
    const r = await resolveVisitorSessionAds(100, lookup as any);
    expect(r).toEqual({ tried: 2, resolved: 1 });
    const saved = queries.find((q) => /SET ad_campaign_name = \$2/.test(q.sql))!;
    expect(saved.params).toEqual(["s1", "BF Search", "SBA", "sba loan", "2026-10-02"]);
    expect(queries.some((q) => /ad_lookup_tries = ad_lookup_tries \+ 1 WHERE session_id = \$1/.test(q.sql) && q.params[0] === "s2")).toBe(true);
  });

  it("retries a click Google has not published yet, up to 3 times, 6 hours apart", async () => {
    await resolveVisitorSessionAds(100, vi.fn(async () => null) as any);
    const pick = queries.find((q) => /FROM visitor_sessions/.test(q.sql) && /SELECT/.test(q.sql))!;
    expect(pick.sql).toContain("ad_lookup_tries < 3");
    expect(pick.sql).toContain("ad_lookup_at < now() - interval '6 hours'");
  });

  it("the visitors report shows the looked-up keyword", async () => {
    const { visitorsReport } = await import("../routes/marketing/adsStory.js");
    await visitorsReport(30, "all");
    const report = queries.find((q) => /FROM visitor_sessions s/.test(q.sql))!;
    expect(report.sql).toContain("COALESCE(att.keyword,s.ad_keyword) AS keyword");
  });

  it("the worker runs the lookup", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { startAdConversionWorker } = await import("../workers/adConversionWorker.js");
      const worker = startAdConversionWorker({} as any);
      await vi.waitFor(() => expect(log.mock.calls.some((c: unknown[]) => c[0] === "[ads_conversion] tick")).toBe(true));
      worker.stop();
      expect(resolveVisitorSessionAds).toHaveBeenCalledWith();
      const line = JSON.parse(String(log.mock.calls.find((c: unknown[]) => c[0] === "[ads_conversion] tick")![1]));
      expect(line).toHaveProperty("visitorAds");
    } finally {
      log.mockRestore();
    }
  });

  describe("every visit gets a landing page", () => {
    const track = async (body: Record<string, unknown>) => {
      const router = (await import("../routes/visitorTrack.js")).default;
      const app = express();
      app.use("/api/track/journey", router);
      const res = await request(app).post("/api/track/journey").send(body);
      expect(res.status).toBe(200);
      return queries.find((q) => /INSERT INTO visitor_sessions/.test(q.sql))!;
    };

    it("an untagged visit takes its first page view", async () => {
      const q = await track({ sessionId: "s9", events: [{ type: "click", path: "/x" }, { type: "page_view", path: "/apply" }] });
      expect(q.params[1]).toBe("/apply");
      // the first landing page recorded for a session is kept
      expect(q.sql).toContain("landing_page = COALESCE(visitor_sessions.landing_page, EXCLUDED.landing_page)");
    });

    it("an explicit landing page still wins", async () => {
      const q = await track({ sessionId: "s9", attribution: { landing_page: "/sba" }, events: [{ type: "pageview", path: "/apply" }] });
      expect(q.params[1]).toBe("/sba");
    });
  });

  it("leaves Google's ad checkers and other bots out of the visitor list, whatever the filter", async () => {
    const { BOT_UA_SQL, visitorsReport } = await import("../routes/marketing/adsStory.js");
    expect(BOT_UA_SQL).toContain("adsbot");
    for (const filter of ["all", "ad", "identified", "abandoned", "submitted"]) {
      queries.length = 0;
      await visitorsReport(30, filter);
      const report = queries.find((q) => /FROM visitor_sessions s/.test(q.sql))!;
      expect(report.sql).toContain(BOT_UA_SQL);
    }
  });
});
