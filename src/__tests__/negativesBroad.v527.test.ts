// BF_SERVER_BLOCK_v527 - Broad match negatives
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, adsSearch, fetchMock } = vi.hoisted(() => ({ queryMock: vi.fn(), adsSearch: vi.fn(), fetchMock: vi.fn() }));

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

import marketing from "../routes/marketing.js";
import { parseNegativeMatchType, addCampaignNegatives, negativeBlastRadius, findNegativeCandidates } from "../services/googleAdsNegatives.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

const BLAST = /AND name <> \$1/;
const prevCid = process.env.GOOGLE_ADS_CUSTOMER_ID;

beforeEach(() => {
  process.env.GOOGLE_ADS_CUSTOMER_ID = "123-456-7890";
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [BLAST, { rows: [{ name: "cheap business loans online", cost: "4.00", conversions: "0" }] }],
  ]));
  adsSearch.mockReset();
  adsSearch.mockResolvedValue([]);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init: any) => {
    const ops = JSON.parse(String(init.body)).operations as unknown[];
    return new Response(JSON.stringify({ results: ops.map((_, i) => ({ resourceName: `customers/1234567890/campaignCriteria/9~${i}` })) }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (prevCid === undefined) delete process.env.GOOGLE_ADS_CUSTOMER_ID;
  else process.env.GOOGLE_ADS_CUSTOMER_ID = prevCid;
});

describe("v527 Broad match negatives", () => {
  it("parses all three match types, defaulting to PHRASE", () => {
    expect(parseNegativeMatchType("BROAD")).toBe("BROAD");
    expect(parseNegativeMatchType("EXACT")).toBe("EXACT");
    expect(parseNegativeMatchType("PHRASE")).toBe("PHRASE");
    expect(parseNegativeMatchType(undefined)).toBe("PHRASE");
    expect(parseNegativeMatchType("broad")).toBe("PHRASE");
  });

  it("rejects a one-word BROAD negative without calling Google", async () => {
    const out = await addCampaignNegatives("999", ["loans"], "BROAD");
    expect(out).toEqual({ added: [], failed: [{ term: "loans", error: "single_word_broad_rejected_use_exact" }] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a multi-word BROAD negative to Google as BROAD", async () => {
    const out = await addCampaignNegatives("999", ["free money"], "BROAD");
    expect(out.added).toEqual(["free money"]);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.operations[0].create.keyword).toEqual({ text: "free money", matchType: "BROAD" });
  });

  it("hides candidates an active BROAD negative already blocks", async () => {
    await findNegativeCandidates(7, 0, "999");
    const sql = String(callsMatching(queryMock, /SELECT name AS search_term/)[0][0]);
    expect(sql).toContain("n.match_type = 'BROAD'");
  });

  it("measures a BROAD blast radius by words, passing the match type to the query", async () => {
    const out = await negativeBlastRadius(["business loans"], "BROAD", " 999 ");
    expect(out[0]).toMatchObject({ term: "business loans", matchType: "BROAD", totalCost: 4 });
    const [sql, params] = callsMatching(queryMock, BLAST)[0] as [string, unknown[]];
    expect(params).toEqual(["business loans", 90, "999", "BROAD"]);
    expect(sql).toContain("WHEN $4::text = 'BROAD'");
  });

  it("the impact route accepts BROAD", async () => {
    const r = await request(app).get("/api/marketing/negative-impact?terms=business%20loans&matchType=BROAD&campaignId=999").set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.impact[0].matchType).toBe("BROAD");
    expect((callsMatching(queryMock, BLAST)[0][1] as unknown[])[3]).toBe("BROAD");
  });

  it("the add route accepts BROAD", async () => {
    const r = await request(app).post("/api/marketing/negative-keywords").set("Authorization", `Bearer ${token}`)
      .send({ campaignId: "999", terms: ["free money", "loans"], matchType: "BROAD" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, matchType: "BROAD", added: ["free money"] });
    expect(r.body.failed).toEqual([{ term: "loans", error: "single_word_broad_rejected_use_exact" }]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).operations[0].create.keyword.matchType).toBe("BROAD");
  });
});
