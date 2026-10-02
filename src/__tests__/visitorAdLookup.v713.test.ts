// BF_SERVER_VISITOR_AD_LOOKUP_v713
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const queries: Array<{ sql: string; params: unknown[] }> = [];
let pending: any[] = [];
vi.mock("../db.js", () => ({ pool: { query: vi.fn(async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return /FROM visitor_sessions/.test(sql) && /SELECT/.test(sql) ? { rows: pending } : { rows: [] }; }) } }));
vi.mock("../services/googleAdsService.js", () => ({ googleAdsConfigured: () => true, googleAdsSearch: vi.fn() }));
vi.mock("../observability/logger.js", () => ({ logError: vi.fn() }));
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
  it("retries a click Google has not published yet, up to 3 times, 6 hours apart", () => {
    const src = readFileSync("src/services/visitorAdLookup.ts", "utf8");
    expect(src).toContain("ad_lookup_tries < 3");
    expect(src).toContain("ad_lookup_at < now() - interval '6 hours'");
  });
  it("the visitors report and the worker use it; every visit gets a landing page", () => {
    expect(readFileSync("src/routes/marketing/adsStory.ts", "utf8")).toContain("COALESCE(att.keyword,s.ad_keyword) AS keyword");
    expect(readFileSync("src/workers/adConversionWorker.ts", "utf8")).toContain("resolveVisitorSessionAds()");
    const track = readFileSync("src/routes/visitorTrack.ts", "utf8");
    expect(track).toContain("const landing = s(a.landing_page) ?? s(firstPage?.path);");
    expect(track).toContain("landing_page = COALESCE(visitor_sessions.landing_page, EXCLUDED.landing_page)");
  });
  it("leaves Google's ad checkers and other bots out of the visitor list", async () => {
    const { BOT_UA_SQL } = await import("../routes/marketing/adsStory.js");
    expect(BOT_UA_SQL).toContain("adsbot");
    expect(readFileSync("src/routes/marketing/adsStory.ts", "utf8")).toContain("::interval\", BOT_UA_SQL];");
  });
});
