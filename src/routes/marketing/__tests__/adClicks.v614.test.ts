// BF_SERVER_BLOCK_v614_AD_CLICKS
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../../../services/googleAdsService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, googleAdsConfigured: () => false };
});

import { buildClickTree } from "../adClicks.js";
import marketing from "../../marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const CLICKS = /FROM contact_ad_attribution a/;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [CLICKS, { rows: [{ campaign: "BF Search - CA", ad_group: "Equipment", ad_id: "333", keyword: "equipment financing canada", clicks: 9 }] }],
  ]));
});

describe("ad clicks tree", () => {
  it("groups campaign > ad group > ad with keyword counts, busiest first", () => {
    const t = buildClickTree([
      { campaign: "BF Search - US", ad_group: "SBA Loans", ad_id: "111", keyword: "apply for sba loan", clicks: 3 },
      { campaign: "BF Search - US", ad_group: "SBA Loans", ad_id: "111", keyword: "sba loans", clicks: 2 },
      { campaign: "BF Search - US", ad_group: "SBA Loans", ad_id: "222", keyword: "sba 7a loan", clicks: 1 },
      { campaign: "BF Search - US", ad_group: "Working Capital", ad_id: "", keyword: "", clicks: 1 },
      { campaign: "BF Search - Canada", ad_group: "Equipment", ad_id: "333", keyword: "equipment financing canada", clicks: 9 },
    ]);
    expect(t.total).toBe(16);
    expect(t.campaigns.map((c) => [c.campaign, c.clicks])).toEqual([["BF Search - Canada", 9], ["BF Search - US", 7]]);
    const us = t.campaigns[1];
    expect(us.adGroups.map((g) => [g.adGroup, g.clicks])).toEqual([["SBA Loans", 6], ["Working Capital", 1]]);
    expect(us.adGroups[0].ads.map((a) => [a.label, a.clicks])).toEqual([["Ad 111", 5], ["Ad 222", 1]]);
    expect(us.adGroups[0].ads[0].keywords).toEqual([{ keyword: "apply for sba loan", clicks: 3 }, { keyword: "sba loans", clicks: 2 }]);
    expect(us.adGroups[1].ads[0].label).toBe("Ad not recorded");
  });

  it("is mounted on the marketing router and reads CRM attribution, all time, leaving out Performance Max", async () => {
    const r = await request(app).get("/api/marketing/ad-clicks").set("Authorization", `Bearer ${token}`).set("X-Silo", "BI");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(9);
    expect(r.body.campaigns[0].campaign).toBe("BF Search - CA");
    const [sql, params] = callsMatching(queryMock, CLICKS)[0] as [string, unknown[]];
    expect(params).toEqual(["BI"]);
    expect(sql).toContain("NOT ILIKE '%performance max%'");
    expect(sql).not.toContain("interval");
  });
});
