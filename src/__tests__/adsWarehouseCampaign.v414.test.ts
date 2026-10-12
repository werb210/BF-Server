// BF_SERVER_ADS_WAREHOUSE_CAMPAIGN_v414 - search-term rows carry their campaign, so two
// campaigns no longer overwrite each other and the negatives list can be scoped.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, adsSearch } = vi.hoisted(() => ({ queryMock: vi.fn(), adsSearch: vi.fn() }));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../services/googleAdsService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, googleAdsConfigured: () => true, googleAdsSearch: adsSearch };
});

import marketing from "../routes/marketing.js";
import { snapshotGoogleAds } from "../services/googleAdsWarehouse.js";
import { findNegativeCandidates } from "../services/googleAdsNegatives.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

const CANDIDATES = /SELECT name AS search_term/;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [CANDIDATES, { rows: [{ search_term: "free loans", cost: "12.50", clicks: "3", impressions: "40", conversions: "0", campaign_id: "111", campaign_name: "BF Search - CA" }] }],
  ]));
  adsSearch.mockReset();
  adsSearch.mockImplementation(async (q: string) => {
    if (q.includes("FROM search_term_view")) {
      return [
        { segments: { date: "2026-10-01" }, searchTermView: { searchTerm: "sba loan" }, campaign: { id: "111", name: "BF Search - US" }, metrics: { costMicros: 2_000_000, clicks: 1 } },
        { segments: { date: "2026-10-01" }, searchTermView: { searchTerm: "sba loan" }, campaign: { id: "222", name: "BF Search - CA" }, metrics: { costMicros: 3_000_000, clicks: 2 } },
      ];
    }
    return [];
  });
});

describe("v414 ads warehouse keeps campaigns apart", () => {
  it("asks Google for the campaign on search-term rows and stores it on each row", async () => {
    const db = { query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[] })) };
    const out = await snapshotGoogleAds(db, 7);
    expect(out.rows).toBe(2);
    const stQuery = adsSearch.mock.calls.map((c) => String(c[0])).find((q) => q.includes("FROM search_term_view"))!;
    expect(stQuery).toContain("campaign.id, campaign.name");
    const upserts = callsMatching(db.query, /INSERT INTO google_ads_daily/).map((c) => c[1] as unknown[]);
    expect(upserts.map((p) => [p[1], p[2], p[9], p[10], p[4]])).toEqual([
      ["search_term", "sba loan", "111", "BF Search - US", 2],
      ["search_term", "sba loan", "222", "BF Search - CA", 3],
    ]);
    // The conflict target includes the campaign, so the second row does not overwrite the first.
    expect(String(callsMatching(db.query, /INSERT INTO google_ads_daily/)[0][0])).toContain("ON CONFLICT (stat_date, level, name, COALESCE(campaign_id, ''))");
  });

  it("widens the natural key so two campaigns no longer overwrite each other", () => {
    const sql = read("migrations/2026_09_22_v414_google_ads_daily_campaign.sql");
    expect(sql).toContain("DROP INDEX IF EXISTS uq_google_ads_daily");
    expect(sql).toContain("uq_google_ads_daily_v414");
    expect(sql).toContain("COALESCE(campaign_id, '')");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS campaign_id");
  });

  it("scopes the candidate list to a campaign when one is given", async () => {
    await findNegativeCandidates(7, 0, " 111 ");
    await findNegativeCandidates(7, 0);
    const calls = callsMatching(queryMock, CANDIDATES);
    expect((calls[0][1] as unknown[])[2]).toBe("111");
    expect((calls[1][1] as unknown[])[2]).toBeNull();
    const sql = String(calls[0][0]);
    expect(sql).toContain("($3::text IS NULL OR campaign_id = $3::text)");
    expect(sql).toContain("GROUP BY name, campaign_id, campaign_name");
  });

  it("returns the campaign with each candidate", async () => {
    expect(await findNegativeCandidates(7, 0, "111")).toEqual([
      { searchTerm: "free loans", cost: 12.5, clicks: 3, impressions: 40, conversions: 0, campaignId: "111", campaignName: "BF Search - CA" },
    ]);
  });

  it("the route forwards campaignId", async () => {
    const r = await request(app).get("/api/marketing/negative-candidates?campaignId=111&days=14&minCost=5").set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.campaignId).toBe("111");
    expect(r.body.candidates[0]).toMatchObject({ searchTerm: "free loans", campaignName: "BF Search - CA" });
    expect(callsMatching(queryMock, CANDIDATES)[0][1]).toEqual([14, 5, "111"]);
  });

  it("the route sends no campaign filter when none is chosen", async () => {
    const r = await request(app).get("/api/marketing/negative-candidates").set("Authorization", `Bearer ${token}`);
    expect(r.body.campaignId).toBeNull();
    expect((callsMatching(queryMock, CANDIDATES)[0][1] as unknown[])[2]).toBeNull();
  });
});
