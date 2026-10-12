// BF_SERVER_ADS_STORY_v707
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  logError: vi.fn(),
  adsConfigured: true,
  adsSearch: vi.fn(),
  suggestions: [] as Array<{ kind: string; title: string; rationale: string }>,
  conversions: 0,
}));
vi.mock("../../../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
vi.mock("../../../observability/logger.js", async (orig) => ({ ...(await orig() as any), logError: (...a: unknown[]) => h.logError(...a) }));
vi.mock("../../../services/googleAdsService.js", async (orig) => ({ ...(await orig() as any), googleAdsConfigured: () => h.adsConfigured, googleAdsSearch: (...a: unknown[]) => h.adsSearch(...a) }));
vi.mock("../../../services/googleAdsSuggestions.js", async (orig) => ({ ...(await orig() as any), suggestionsConfigured: () => true, buildSuggestions: async () => ({ suggestions: h.suggestions }) }));
vi.mock("../../../services/googleAdsNegativeGuard.js", async (orig) => ({ ...(await orig() as any), accountConversions: async () => h.conversions }));
vi.mock("../../../services/adsPicture.js", () => ({ fullPictureInsights: async () => [] }));
import { buildStoryRows, storyBy, windowDays } from "../adsStory.js";
import marketing from "../../marketing.js";
import adminRouter from "../../admin.js";
import { applyAdRules } from "../../../services/adsRules.js";

describe("ads story rows",()=>{
 it("joins spend to outcomes and computes metrics",()=>{ const rows=buildStoryRows([{k:"BF Search",people:4,started:3,submitted:2,qualified:1,funded:1,funded_amount:"100000"}],[{k:"BF Search",spend:"1000",clicks:50},{k:"Idle",spend:"10",clicks:1}],.03); const bf=rows.find(r=>r.key==="BF Search")!; expect(bf.commission).toBe(3000); expect(bf.roas).toBe(3); expect(bf.costPerSubmit).toBe(500); expect(rows.find(r=>r.key==="Idle")?.roas).toBe(0); });
 it("keeps missing spend null",()=>expect(buildStoryRows([{k:"Ad 1",people:1}],[],.03)[0].spend).toBeNull());
 it("parses inputs safely",()=>{expect(storyBy("keyword")).toBe("keyword");expect(storyBy("no")).toBe("campaign");expect(windowDays("30")).toBe(30);expect(windowDays("9999")).toBe(90);});
});

describe("wiring", () => {
  const admin = "Bearer " + jwt.sign({ sub: "74747474-7474-4474-8474-747474747474", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
  const app = express();
  app.use(express.json());
  app.use("/api/marketing", marketing);

  beforeEach(() => {
    h.query.mockReset();
    h.query.mockImplementation(answerBySql([]));
    h.logError.mockReset();
    h.adsSearch.mockReset();
    h.adsConfigured = true;
  });

  it("mounts the story routes under /api/marketing", async () => {
    h.query.mockImplementation(answerBySql([
      [/FROM contact_ad_attribution/, { rows: [{ k: "BF Search", people: 2, started: 1, submitted: 1, qualified: 0, funded: 0, funded_amount: "0" }] }],
    ]));
    const r = await request(app).get("/api/marketing/ads-story?days=30&by=campaign").set("Authorization", admin);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ days: 30, by: "campaign" });
    expect(r.body.rows[0]).toMatchObject({ key: "BF Search", people: 2 });
  });

  it("guards pauses: no pause suggestion while Google Ads records no conversions", async () => {
    h.suggestions = [
      { kind: "pause_campaign", title: "Pause BF Search", rationale: "no conversions" },
      { kind: "add_negative", title: "Add negative 'free'", rationale: "wasted spend" },
    ];
    h.conversions = 0;
    const none = await request(app).get("/api/marketing/google-ads/suggestions").set("Authorization", admin);
    const kinds = (none.body.data ?? none.body).suggestions.map((s: { kind: string }) => s.kind);
    expect(kinds).toEqual(["add_negative"]);
    expect((none.body.data ?? none.body).caveat).toMatch(/pause suggestions are held back/);
    h.conversions = 4;
    const some = await request(app).get("/api/marketing/google-ads/suggestions").set("Authorization", admin);
    expect((some.body.data ?? some.body).suggestions.map((s: { kind: string }) => s.kind)).toEqual(["pause_campaign", "add_negative"]);
    /* BF_SERVER_MAYA_ADS_INSIGHTS_v712: shared rule */
    expect(applyAdRules([{ kind: "pause_campaign", title: "t", rationale: "r" } as any], { conversions: 0 }).suggestions).toEqual([]);
  });

  it("reconciles negatives safely", async () => {
    // Google returned nothing: never read as "every negative was removed".
    h.adsSearch.mockResolvedValue([]);
    await request(app).get("/api/marketing/negative-keywords/recent").set("Authorization", admin);
    expect(callsMatching(h.query, /UPDATE ads_negatives_log SET removed_at/)).toHaveLength(0);
    // Live names: anything not among them is marked removed.
    h.adsSearch.mockResolvedValue([{ campaignCriterion: { resourceName: "customers/1/campaignCriteria/2~3" } }]);
    await request(app).get("/api/marketing/negative-keywords/recent").set("Authorization", admin);
    expect(callsMatching(h.query, /UPDATE ads_negatives_log SET removed_at/)[0][1]).toEqual([["customers/1/campaignCriteria/2~3"]]);
    // A failed read is logged and the list is still served.
    h.adsSearch.mockRejectedValue(new Error("quota"));
    const r = await request(app).get("/api/marketing/negative-keywords/recent").set("Authorization", admin);
    expect(r.status).toBe(200);
    expect(h.logError).toHaveBeenCalledWith("negatives_reconcile_failed", { message: "quota" });
  });

  it("exposes stuck jobs", async () => {
    const stuckRow = { id: "j1", type: "ocr", status: "pending", attempts: "3" };
    h.query.mockImplementation(answerBySql([[/created_at < now\(\) - interval '1 hour'/, { rows: [stuckRow] }]]));
    // BF_SERVER_v789 - the route now answers over HTTP (it used to hang).
    const layer = (adminRouter as any).stack.find((l: any) => l.route?.path === "/job-queue" && l.route.methods.get);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const json = vi.fn();
    await handler({ headers: {} }, { json }, () => undefined);
    const out = json.mock.calls[0][0];
    expect(out.data.stuck).toEqual([stuckRow]);
    expect(out.data.stuckOverAnHour).toEqual([stuckRow]);
  });
});
