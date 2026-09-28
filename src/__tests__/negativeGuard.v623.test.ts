// BF_SERVER_NEGATIVE_GUARD_v623
import { describe, it, expect, vi } from "vitest";

vi.mock("../db.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../services/googleAdsService.js", () => ({
  GOOGLE_ADS_API_VERSION: "v24",
  loginCid: () => "",
  googleAdsSearch: vi.fn(async () => []),
}));
vi.mock("../services/googleAdsConversions.js", () => ({ accessToken: vi.fn(async () => "t") }));

import { negativeBlocks, protectionReason } from "../services/googleAdsNegativeGuard.js";

describe("negativeBlocks", () => {
  it("phrase 'loan canada' blocks the Canada keywords Google flagged", () => {
    expect(negativeBlocks("loan canada", "PHRASE", "small business loan canada")).toBe(true);
    expect(negativeBlocks("loan canada", "PHRASE", "term loan canada")).toBe(true);
    expect(negativeBlocks("loan canada", "PHRASE", "[small business loan canada $40000]")).toBe(true);
    expect(negativeBlocks("loan canada", "PHRASE", "canada loan")).toBe(false);
  });
  it("exact blocks only the identical search", () => {
    expect(negativeBlocks("canadian business funding program", "EXACT", "[canadian business funding program]")).toBe(true);
    expect(negativeBlocks("startups", "EXACT", "bridge financing for startups")).toBe(false);
  });
  it("broad blocks when every word is present in any order", () => {
    expect(negativeBlocks("free business loan", "BROAD", "loan for free business")).toBe(true);
    expect(negativeBlocks("free business loan", "BROAD", "business loan")).toBe(false);
  });
});

describe("protectionReason", () => {
  const p = { keywords: ["business loans", "sba loan requirements"], leadKeywords: ["equipment financing"], convertedSearches: ["invoice factoring canada"] };
  it("refuses a negative that blocks a live keyword", () => {
    expect(protectionReason("business loans", "EXACT", p)).toMatch(/^would_block_keyword/);
    expect(protectionReason("loan requirements", "PHRASE", p)).toMatch(/^would_block_keyword/);
  });
  it("refuses one that blocks a lead keyword or a converting search", () => {
    expect(protectionReason("equipment financing", "EXACT", p)).toMatch(/^would_block_lead_keyword/);
    expect(protectionReason("factoring canada", "PHRASE", p)).toMatch(/^would_block_converting_search/);
  });
  it("allows a genuinely unrelated search", () => {
    expect(protectionReason("open a coffee shop", "EXACT", p)).toBeNull();
  });
});
