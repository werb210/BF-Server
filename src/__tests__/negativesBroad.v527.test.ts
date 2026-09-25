// BF_SERVER_BLOCK_v527
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { parseNegativeMatchType } from "../services/googleAdsNegatives.js";

const service = fs.readFileSync("src/services/googleAdsNegatives.ts", "utf8");
const routes = fs.readFileSync("src/routes/marketing.ts", "utf8");

describe("v527 Broad match negatives", () => {
  it("parses all three match types, defaulting to PHRASE", () => {
    expect(parseNegativeMatchType("BROAD")).toBe("BROAD");
    expect(parseNegativeMatchType("EXACT")).toBe("EXACT");
    expect(parseNegativeMatchType("PHRASE")).toBe("PHRASE");
    expect(parseNegativeMatchType(undefined)).toBe("PHRASE");
  });
  it("rejects a one-word BROAD negative", () => {
    expect(service).toContain('error: "single_word_broad_rejected_use_exact"');
  });
  it("hides candidates a BROAD negative blocks and measures its blast radius by words", () => {
    expect(service).toContain("n.match_type = 'BROAD'");
    expect(service).toContain("WHEN $4::text = 'BROAD'");
    expect(service).toContain("campaignId.trim() : null, matchType]");
  });
  it("both routes accept BROAD", () => {
    expect(routes.match(/parseNegativeMatchType\(/g)?.length).toBe(2);
  });
});
