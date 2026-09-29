// BF_SERVER_MAYA_ADS_v683
import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import router, { adsKeywords, adsNegatives, confirmToken, resolveCampaign, tokenValid } from "../routes/mayaStaffAds.js";

const fake = (answers: Array<[string, any[]]>) => (async (sql: string) => {
  const hit = answers.find(([needle]) => sql.includes(needle));
  if (!hit) throw new Error("unexpected SQL: " + sql.slice(0, 80));
  return { rows: hit[1] };
}) as any;
const campaigns: Array<[string, any[]]> = [["DISTINCT ON (campaign_id)", [{ campaign_id: "111", campaign_name: "BF Search - US" }, { campaign_id: "222", campaign_name: "BF Search - CA" }]]];

describe("v683 Maya Google Ads", () => {
  it("confirm tokens only match the exact change and expire", () => {
    const t = confirmToken(["add", "111", "EXACT", "free grants"], Date.now() + 60_000, "s3cret-value");
    expect(tokenValid(t, ["add", "111", "EXACT", "free grants"], Date.now(), "s3cret-value")).toBe(true);
    expect(tokenValid(t, ["add", "111", "EXACT", "loans"], Date.now(), "s3cret-value")).toBe(false);
    expect(tokenValid(t, ["add", "111", "EXACT", "free grants"], Date.now() + 120_000, "s3cret-value")).toBe(false);
    expect(tokenValid("garbage", ["add"], Date.now(), "s3cret-value")).toBe(false);
  });

  it("finds a campaign by id or by name", async () => {
    const q = fake(campaigns);
    expect(await resolveCampaign(q, "222")).toEqual({ id: "222", name: "BF Search - CA" });
    expect(await resolveCampaign(q, "bf search - us")).toEqual({ id: "111", name: "BF Search - US" });
    expect(await resolveCampaign(q, "canada")).toBeNull();
  });

  it("lists keywords with spend and the live keyword list, and still answers when Google is down", async () => {
    const q = fake([["level = 'keyword'", [{ keyword: "sba loan", campaign_name: "BF Search - US", cost: 40.5, clicks: 9, impressions: 300, conversions: 1 }]], ...campaigns]);
    const up = await adsKeywords(q, 30, async () => [{ campaignId: "111", adGroupId: "9", text: "sba loan" }]);
    expect(up.keywords_with_spend[0]).toMatchObject({ keyword: "sba loan", spend: 40.5, conversions: 1 });
    expect(up.active_keywords).toEqual([{ campaign_id: "111", keyword: "sba loan" }]);
    const down = await adsKeywords(q, 30, async () => { throw new Error("no token"); });
    expect(down.active_keywords).toEqual([]);
    expect(down.note).toContain("could not be reached");
  });

  it("lists negatives and conflicts", async () => {
    const q = fake([["FROM ads_negatives_log", [{ id: "n1", campaign_id: "111", term: "jobs", match_type: "EXACT", campaign_name: "BF Search - US" }]], ...campaigns]);
    const out = await adsNegatives(q, async () => [{ negative: "loan", blocks: ["sba loan"] }]);
    expect(out.negatives).toHaveLength(1);
    expect(out.conflicts).toHaveLength(1);
    expect(out.summary).toBe("1 negative(s) added through the portal are active; 1 negative(s) in Google Ads block one of our own keywords.");
  });

  it("every ads route refuses calls without Maya's service token", async () => {
    const app = express().use(express.json()).use(router);
    for (const path of ["/staff/ads-keywords", "/staff/ads-negatives", "/staff/ads-negatives/add", "/staff/ads-negatives/remove"]) {
      expect((await request(app).post(path).send({})).status).toBe(401);
    }
  });
});
