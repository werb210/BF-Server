// BF_SERVER_MAYA_ADS_TOOLS_v712
import express from "express";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import { API_ROUTE_MOUNTS } from "../routes/routeRegistry.js";
import { ADS_RULES } from "../services/adsRules.js";

const { verifyMock, auditMock } = vi.hoisted(() => ({ verifyMock: vi.fn(() => true), auditMock: vi.fn(async () => undefined) }));
vi.mock("../routes/mayaStaff.js", async () => {
  const actual = await vi.importActual<typeof import("../routes/mayaStaff.js")>("../routes/mayaStaff.js");
  return { ...actual, verifyMayaService: verifyMock, audit: auditMock };
});
vi.mock("../routes/marketing/adsStory.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  windowDays: (d: unknown, def = 30) => Number(d) || def,
  storyBy: () => "campaign",
  storyReport: vi.fn(async () => ({ days: 30, totals: { spend: 100, clicks: 5, people: 2, started: 1, submitted: 1, qualified: 0, funded: 0, commission: 0, roas: null } })),
  visitorsReport: vi.fn(async () => ({ days: 30, visitors: [] })),
  dropoffReport: vi.fn(async () => ({ days: 30, totals: { started: 1, submitted: 0 }, steps: [] })),
}));
vi.mock("../services/googleHealth.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getGoogleHealth: vi.fn(async () => ({ checks: [] })) }));
vi.mock("../services/ga4Service.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), ga4Configured: () => false, runGa4Report: vi.fn() }));
vi.mock("../services/customerMatchLists.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listStatus: vi.fn(async () => []),
  customerMatchConfigured: () => false,
  listApplicants: vi.fn(async () => ({ rows: [] })),
}));

describe("Maya's Ads report tools", () => {
  it("has a staff tool for each Ads report, reachable at /api/maya, each answer carrying the rules", async () => {
    const maya = API_ROUTE_MOUNTS.find((m) => m.path === "/maya")!;
    expect(maya).toBeDefined();
    const app = express();
    app.use(express.json());
    app.use("/api/maya", maya.router);
    for (const p of ["/staff/ads-story", "/staff/ads-visitors", "/staff/ads-dropoff", "/staff/ads-health", "/staff/ga4", "/staff/ads-audiences"]) {
      const res = await request(app).post(`/api/maya${p}`).send({ days: 30 });
      expect(res.status, p).toBe(200);
      expect(res.body.ok, p).toBe(true);
      expect(res.body.ad_rules, p).toEqual(ADS_RULES);
    }
  });

  it("refuses a caller without the Maya service token", async () => {
    verifyMock.mockReturnValueOnce(false);
    const router = (await import("../routes/mayaStaffAdsInsights.js")).default;
    const app = express();
    app.use(express.json());
    app.use(router);
    expect((await request(app).post("/staff/ads-story").send({})).status).toBe(401);
  });
});
