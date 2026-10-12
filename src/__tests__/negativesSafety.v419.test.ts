// BF_SERVER_NEGATIVES_SAFETY_v419 - a negative can be previewed and undone.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, adsSearch, fetchMock, logError } = vi.hoisted(() => ({ queryMock: vi.fn(), adsSearch: vi.fn(), fetchMock: vi.fn(), logError: vi.fn() }));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../services/googleAdsService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, googleAdsConfigured: () => true, googleAdsSearch: adsSearch };
});
vi.mock("../services/googleAdsConversions.js", async (orig) => {
  const real: any = await orig();
  return { ...real, accessToken: async () => "tok" };
});
vi.mock("../observability/logger.js", async (orig) => {
  const real: any = await orig();
  return { ...real, logError };
});

import marketing from "../routes/marketing.js";
import { addCampaignNegatives, negativeBlastRadius, removeCampaignNegative } from "../services/googleAdsNegatives.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);

const BLAST = /AND name <> \$1/;
const LOG_INSERT = /INSERT INTO ads_negatives_log/;
const prevCid = process.env.GOOGLE_ADS_CUSTOMER_ID;
const googleBodies = () => fetchMock.mock.calls.map((c) => JSON.parse(String(c[1].body)));

beforeEach(() => {
  process.env.GOOGLE_ADS_CUSTOMER_ID = "1234567890";
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [BLAST, { rows: [
      { name: "business loans canada", cost: "30.00", conversions: "2" },
      { name: "business loans free", cost: "5.50", conversions: "0" },
    ] }],
    [/SELECT resource_name FROM ads_negatives_log WHERE id = \$1/, (_s: string, p?: unknown[]) =>
      p?.[0] === "neg-1" ? { rows: [{ resource_name: "customers/1234567890/campaignCriteria/9~77" }] } : { rows: [] }],
  ]));
  adsSearch.mockReset();
  adsSearch.mockResolvedValue([]);
  logError.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init: any) => {
    const ops = JSON.parse(String(init.body)).operations as Array<Record<string, unknown>>;
    if (ops[0]?.remove) return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ results: ops.map((_, i) => ({ resourceName: `customers/1234567890/campaignCriteria/9~${100 + i}` })) }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (prevCid === undefined) delete process.env.GOOGLE_ADS_CUSTOMER_ID;
  else process.env.GOOGLE_ADS_CUSTOMER_ID = prevCid;
});

describe("v419 a negative can be previewed and undone", () => {
  it("keeps the resourceName Google returns for each term", async () => {
    const out = await addCampaignNegatives("9", ["free money", "cheap loans"], "PHRASE");
    expect(out.resourceNames).toEqual({
      "free money": "customers/1234567890/campaignCriteria/9~100",
      "cheap loans": "customers/1234567890/campaignCriteria/9~101",
    });
  });

  it("blast radius counts converting searches, not just cost", async () => {
    const [r] = await negativeBlastRadius(["business loans"], "PHRASE");
    expect(r).toMatchObject({ term: "business loans", totalCost: 35.5, convertingCount: 1 });
    expect(r.alsoBlocks).toEqual([
      { searchTerm: "business loans canada", cost: 30, conversions: 2 },
      { searchTerm: "business loans free", cost: 5.5, conversions: 0 },
    ]);
  });

  it("EXACT has no blast radius by definition", async () => {
    const out = await negativeBlastRadius(["business loans"], "EXACT");
    expect(out).toEqual([{ term: "business loans", matchType: "EXACT", alsoBlocks: [], totalCost: 0, convertingCount: 0 }]);
    expect(callsMatching(queryMock, BLAST)).toHaveLength(0);
  });

  it("removal hits Google by resourceName", async () => {
    await removeCampaignNegative("customers/1234567890/campaignCriteria/9~77");
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/customers\/1234567890\/campaignCriteria:mutate$/);
    expect(googleBodies()[0]).toEqual({ operations: [{ remove: "customers/1234567890/campaignCriteria/9~77" }] });
  });

  it("the undo route removes it in Google, then marks the log row removed", async () => {
    const r = await auth(request(app).post("/api/marketing/negative-keywords/neg-1/remove"));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(googleBodies()[0]).toEqual({ operations: [{ remove: "customers/1234567890/campaignCriteria/9~77" }] });
    expect(callsMatching(queryMock, /UPDATE ads_negatives_log SET removed_at = now\(\) WHERE id = \$1/)[0][1]).toEqual(["neg-1"]);
  });

  it("the undo route leaves the log alone when Google refuses", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const r = await auth(request(app).post("/api/marketing/negative-keywords/neg-1/remove"));
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("google_ads_remove_failed");
    expect(callsMatching(queryMock, /UPDATE ads_negatives_log SET removed_at/)).toHaveLength(0);
  });

  it("the undo route 404s an unknown or already-removed negative", async () => {
    const r = await auth(request(app).post("/api/marketing/negative-keywords/ghost/remove"));
    expect(r.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("every added negative is logged with its resourceName", async () => {
    const r = await auth(request(app).post("/api/marketing/negative-keywords")).send({ campaignId: "9", terms: ["free money", "cheap loans"], matchType: "PHRASE" });
    expect(r.status).toBe(200);
    expect(r.body.added).toEqual(["free money", "cheap loans"]);
    const logged = callsMatching(queryMock, LOG_INSERT).map((c) => (c[1] as unknown[]).slice(0, 4));
    expect(logged).toEqual([
      ["9", "free money", "PHRASE", "customers/1234567890/campaignCriteria/9~100"],
      ["9", "cheap loans", "PHRASE", "customers/1234567890/campaignCriteria/9~101"],
    ]);
  });

  it("a failed audit insert is logged, never silent", async () => {
    queryMock.mockImplementation(answerBySql([[LOG_INSERT, new Error("insert failed")]]));
    const r = await auth(request(app).post("/api/marketing/negative-keywords")).send({ campaignId: "9", terms: ["free money"] });
    expect(r.status).toBe(200);
    expect(logError).toHaveBeenCalledWith("ads_negative_audit_insert_failed", expect.objectContaining({ campaignId: "9", term: "free money", message: "insert failed" }));
  });
});
