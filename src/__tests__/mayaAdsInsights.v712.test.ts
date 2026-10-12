// BF_SERVER_MAYA_ADS_INSIGHTS_v712
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "./helpers/answerBySql.js";
import { applyAdRules, picturedInsights, isToddOnlyAction, ADS_RULES } from "../services/adsRules.js";

const { queryMock, built, insights, sendTransactional } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  built: { suggestions: [] as any[] },
  insights: vi.fn(),
  sendTransactional: vi.fn(),
}));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../services/googleAdsSuggestions.js", async (orig) => {
  const real: any = await orig();
  return { ...real, suggestionsConfigured: () => true, buildSuggestions: async () => ({ configured: true, suggestions: built.suggestions }), applySuggestion: vi.fn(async () => ({ ok: true })) };
});
vi.mock("../services/adsPicture.js", () => ({ fullPictureInsights: insights }));
vi.mock("../services/sendgridService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, sendgridConfigured: () => true, sendTransactional };
});

import marketing from "../routes/marketing.js";
import { maybeSendWeeklyAdsEmail } from "../services/adsWeeklyEmail.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

const sg = (kind: string, title = "t", rationale = "r") => ({ id: kind, kind, title, rationale, severity: "info" as const, action: { type: kind } as any });

describe("Boreal's ad rules", () => {
  it("holds back pause advice while Google records no conversions", () => { const r = applyAdRules([sg("pause_campaign"), sg("pause_keyword"), sg("add_negative")], { conversions: 0 }); expect(r.suggestions.map((s) => s.kind)).toEqual(["add_negative"]); expect(r.caveats[0]).toContain("no conversions"); expect(applyAdRules([sg("pause_campaign")], { conversions: 3 }).suggestions).toHaveLength(1); });
  it("marks Todd-only advice", () => { const r = applyAdRules([sg("set_budget", "Raise budget")], { conversions: 5 }); expect(r.suggestions[0].toddOnly).toBe(true); expect(r.suggestions[0].title).toContain("(Todd decides)"); expect(isToddOnlyAction({ type: "set_budget" })).toBe(true); expect(isToddOnlyAction({ type: "pause_keyword" })).toBe(false); });
  it("drops Quebec and demographic targeting", () => { expect(applyAdRules([sg("x", "Target Quebec"), sg("y", "Narrow by gender"), sg("z", "Add negative")], { conversions: 5 }).suggestions.map((s) => s.kind)).toEqual(["z"]); });
  it("states five rules", () => { expect(ADS_RULES).toHaveLength(5); expect(ADS_RULES.join(" ")).toMatch(/Quebec/); });
});
describe("full-picture findings", () => { it("turns reports into findings", () => { const out = picturedInsights({ story: { totals: { clicks: 300, started: 12, submitted: 0 } }, dropoff: { steps: [{ step: 1, stopped: 9, from_ad: 7 }, { step: 3, stopped: 2 }] }, health: { checks: [{ label: "Conversion upload", status: "fail", detail: "rejected" }, { label: "GA4", status: "ok", detail: "" }] } }); expect(out.map((i) => i.title)).toEqual(["Ad clicks are not becoming submitted applications", "Most unfinished applications stop at Step 1", "Google connection problem: Conversion upload"]); }); });

describe("wiring", () => {
  const prevMutate = process.env.GOOGLE_ADS_ALLOW_MUTATE;
  beforeEach(() => {
    built.suggestions = [sg("pause_campaign", "Pause campaign \"Waste\""), sg("set_budget", "Raise budget on \"Winner\" by 20%")];
    insights.mockReset();
    insights.mockResolvedValue([{ title: "Ad clicks are not becoming submitted applications", detail: "300 clicks, 0 submitted" }]);
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([
      [/SELECT COALESCE\(SUM\(conversions\), 0\)::numeric\(12,2\) AS c FROM google_ads_daily/, { rows: [{ c: "0" }] }],
      [/INSERT INTO ads_weekly_reports/, { rows: [{ week_start: "2026-10-12" }], rowCount: 1 }],
    ]));
    sendTransactional.mockReset();
    sendTransactional.mockResolvedValue({ ok: true, status: 202 });
  });
  afterEach(() => {
    if (prevMutate === undefined) delete process.env.GOOGLE_ADS_ALLOW_MUTATE;
    else process.env.GOOGLE_ADS_ALLOW_MUTATE = prevMutate;
  });

  it("the portal panel applies the rules and adds the findings", async () => {
    const r = await request(app).get("/api/marketing/google-ads/suggestions?days=30").set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data.suggestions.map((s: any) => s.kind)).toEqual(["set_budget"]);
    expect(r.body.data.suggestions[0]).toMatchObject({ toddOnly: true, title: "Raise budget on \"Winner\" by 20% (Todd decides)" });
    expect(r.body.data.caveat).toContain("no conversions");
    expect(r.body.data.insights).toEqual([{ title: "Ad clicks are not becoming submitted applications", detail: "300 clicks, 0 submitted" }]);
    expect(insights).toHaveBeenCalledWith(30);
  });

  it("budget and bid changes are refused as todd_only even when mutation is enabled", async () => {
    process.env.GOOGLE_ADS_ALLOW_MUTATE = "true";
    const r = await request(app).post("/api/marketing/google-ads/suggestions/apply").set("Authorization", `Bearer ${token}`)
      .send({ action: { type: "set_budget", resourceName: "customers/1/campaignBudgets/2", amountMicros: 1 } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("todd_only");
  });

  it("the Monday email uses the same rules and the 7-day findings", async () => {
    const out = await maybeSendWeeklyAdsEmail(new Date("2026-10-12T15:00:00Z"), true);
    expect(out.sent).toBe(true);
    expect(insights).toHaveBeenCalledWith(7);
    const html = String(sendTransactional.mock.calls[0][0].html);
    expect(html).toContain("Ad clicks are not becoming submitted applications - 300 clicks, 0 submitted");
    expect(html).toContain("Raise budget on &quot;Winner&quot; by 20% (Todd decides)");
    expect(html).not.toContain("Pause campaign");
    expect(html).toContain("pause suggestions are held back");
  });
});
