// BF_SERVER_NEGATIVE_GUARD_ROUTES_v624
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";
import { bearer } from "./helpers/staffToken.js";

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  protectedSearches: vi.fn(),
  listConflicts: vi.fn(async () => [{ resourceName: "customers/1/campaignCriteria/2~3", term: "equipment loan" }]),
  removeNegativeCriterion: vi.fn(async () => undefined),
  findNegativeCandidates: vi.fn(),
  addCampaignNegatives: vi.fn(),
}));
vi.mock("../db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db.js")>()),
  pool: { query: h.queryMock, connect: async () => ({ query: h.queryMock, release: () => undefined }) },
  runQuery: h.queryMock,
  dbQuery: h.queryMock,
}));
vi.mock("../services/googleAdsNegativeGuard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/googleAdsNegativeGuard.js")>()),
  protectedSearches: h.protectedSearches,
  accountConversions: vi.fn(async () => 4),
  listConflicts: h.listConflicts,
  removeNegativeCriterion: h.removeNegativeCriterion,
}));
vi.mock("../services/googleAdsNegatives.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/googleAdsNegatives.js")>()),
  findNegativeCandidates: h.findNegativeCandidates,
  addCampaignNegatives: h.addCampaignNegatives,
}));

const PROTECTED = { keywords: ["equipment financing"], leadKeywords: ["truck loan"], convertedSearches: ["working capital"] };

async function marketingApp() {
  const { default: marketing } = await import("../routes/marketing.js");
  const app = express();
  app.use(express.json());
  app.use("/api/marketing", marketing);
  return app;
}

describe("routes", () => {
  beforeEach(() => {
    h.queryMock.mockReset();
    h.queryMock.mockImplementation(answerBySql([]));
    h.protectedSearches.mockReset();
    h.addCampaignNegatives.mockReset();
    h.findNegativeCandidates.mockReset();
  });

  it("guards adds: no keyword list, no negatives", async () => {
    h.protectedSearches.mockRejectedValue(new Error("ads api down"));
    const res = await request(await marketingApp())
      .post("/api/marketing/negative-keywords")
      .set("Authorization", bearer("Admin"))
      .send({ campaignId: "c1", terms: ["free money"], matchType: "EXACT" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("keyword_check_unavailable");
    expect(h.addCampaignNegatives).not.toHaveBeenCalled();
  });

  it("guards adds: refuses a negative that would block a protected search", async () => {
    h.protectedSearches.mockResolvedValue(PROTECTED);
    h.addCampaignNegatives.mockResolvedValue({ added: ["free money"], failed: [], resourceNames: { "free money": "customers/1/campaignCriteria/9" } });
    const res = await request(await marketingApp())
      .post("/api/marketing/negative-keywords")
      .set("Authorization", bearer("Admin"))
      .send({ campaignId: "c1", terms: ["free money", "working capital"], matchType: "EXACT" });
    expect(res.status).toBe(200);
    expect(h.addCampaignNegatives).toHaveBeenCalledWith("c1", ["free money"], "EXACT");
    expect(res.body.failed.map((f: { term: string }) => f.term)).toEqual(["working capital"]);
    expect((callsMatching(h.queryMock, /INSERT INTO ads_negatives_log/)[0]![1] as unknown[]).slice(0, 4)).toEqual(["c1", "free money", "EXACT", "customers/1/campaignCriteria/9"]);
  });

  it("filters candidates by clicks and protection, and says when the keyword check failed", async () => {
    h.findNegativeCandidates.mockResolvedValue([
      { searchTerm: "free money", clicks: 5 },
      { searchTerm: "working capital", clicks: 9 },
      { searchTerm: "one click wonder", clicks: 1 },
    ]);
    h.protectedSearches.mockResolvedValue(PROTECTED);
    const app = await marketingApp();
    const res = await request(app).get("/api/marketing/negative-candidates").query({ minClicks: 3 }).set("Authorization", bearer("Admin"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ minClicks: 3, keywordCheck: "ok", accountConversions: 4 });
    expect(res.body.candidates.map((c: { searchTerm: string }) => c.searchTerm)).toEqual(["free money"]);
    expect(res.body.protectedTerms).toEqual(expect.arrayContaining(["equipment financing", "truck loan", "working capital"]));

    h.protectedSearches.mockRejectedValue(new Error("ads api down"));
    const degraded = await request(app).get("/api/marketing/negative-candidates").query({ minClicks: 3 }).set("Authorization", bearer("Admin"));
    expect(degraded.body.keywordCheck).toBe("unavailable");
  });

  it("exposes conflicts and removes one", async () => {
    const app = await marketingApp();
    const list = await request(app).get("/api/marketing/negative-conflicts").query({ campaignId: "c1" }).set("Authorization", bearer("Admin"));
    expect(list.status).toBe(200);
    expect(list.body.conflicts).toHaveLength(1);
    expect(h.listConflicts).toHaveBeenCalledWith("c1");
    const rm = await request(app)
      .post("/api/marketing/negative-conflicts/remove")
      .set("Authorization", bearer("Admin"))
      .send({ resourceName: "customers/1/campaignCriteria/2~3" });
    expect(rm.body).toEqual({ ok: true });
    expect(h.removeNegativeCriterion).toHaveBeenCalledWith("customers/1/campaignCriteria/2~3");
    expect((await request(app).post("/api/marketing/negative-conflicts/remove").set("Authorization", bearer("Admin")).send({})).status).toBe(400);
  });

  it("client tokens skip the staff lookup; only staff humans reach the users table", async () => {
    // BF_SERVER_v789_STAFF_USER_STATE - only staff-human principals reach the users lookup.
    const app = await marketingApp();
    const usersLookups = () => h.queryMock.mock.calls.filter((c) => /FROM users WHERE id = \$1/.test(sqlText(c[0]))).length;
    const client = jwt.sign({ sub: "client:+15875550100", role: "client", isClient: true, phone: "+15875550100" }, String(process.env.JWT_SECRET));
    expect((await request(app).get("/api/marketing/negative-conflicts").set("Authorization", `Bearer ${client}`)).status).toBe(403);
    const service = jwt.sign({ id: "agent-service", role: "Staff", principal: "service", service: "maya" }, String(process.env.JWT_SECRET));
    await request(app).get("/api/marketing/negative-conflicts").set("Authorization", `Bearer ${service}`);
    expect(usersLookups()).toBe(0);
    await request(app).get("/api/marketing/negative-conflicts").set("Authorization", bearer("Admin"));
    expect(usersLookups()).toBeGreaterThan(0);
  });
});

describe("client messages", () => {
  it("the dead document_requirements query is gone", async () => {
    const APP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    h.queryMock.mockReset();
    h.queryMock.mockImplementation(
      answerBySql([
        [/WITH app_phones AS/, { rows: [{ total: 1, mine: 1, known: 1 }] }],
        [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [{ id: APP }] }],
      ]),
    );
    const { default: clientRouter } = await import("../routes/client/index.js");
    const app = express();
    app.use(express.json());
    app.use("/api/client", clientRouter);
    const tok = jwt.sign({ sub: "client:+15875550100", role: "client", isClient: true, phone: "+15875550100" }, String(process.env.JWT_SECRET));
    const res = await request(app).get("/api/client/messages").query({ applicationId: APP }).set("Authorization", `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(callsMatching(h.queryMock, /FROM communications_messages/).length).toBeGreaterThan(0);
    expect(callsMatching(h.queryMock, /document_requirements/)).toHaveLength(0);
  }, 60_000);
});
