// BF_SERVER_BLOCK_v457_HIDE_BLOCKED_TERMS
// A search already blocked by an active negative must leave the candidate list.
// Verified against real Postgres 16 when written; this pins the query's rules.
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const src = fs.readFileSync("src/services/googleAdsNegatives.ts", "utf8");
const sql = src.slice(src.indexOf("export async function findNegativeCandidates"), src.indexOf("export type AddResult"));

describe("v457 blocked searches leave the candidate list", () => {
  it("excludes searches matched by an active negative", () => {
    expect(sql).toContain("AND NOT EXISTS (");
    expect(sql).toContain("FROM ads_negatives_log n");
    expect(sql).toContain("n.removed_at IS NULL");
  });

  it("only a negative on the same campaign hides a search", () => {
    expect(sql).toContain("n.campaign_id = google_ads_daily.campaign_id");
  });

  it("exact matching ignores case", () => {
    expect(sql).toContain("lower(n.term) = lower(google_ads_daily.name)");
  });

  it("a phrase negative matches whole words only", () => {
    expect(sql).toContain("n.match_type = 'PHRASE'");
    expect(sql).toContain("strpos(' ' || lower(google_ads_daily.name) || ' ', ' ' || lower(n.term) || ' ') > 0");
  });

  it("keeps the v414 campaign scoping", () => {
    expect(sql).toContain("($3::text IS NULL OR campaign_id = $3::text)");
    expect(sql).toContain("GROUP BY name, campaign_id, campaign_name");
  });
});
