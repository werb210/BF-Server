// BF_SERVER_MATCH_REFRESH_v732
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
describe("lender lists refresh when lenders change", () => {
  it("open files computed before now are refreshed once", () => {
    expect(readFileSync("migrations/2026_10_03_v732_refresh_open_matches.sql", "utf8")).toContain("UPDATE applications SET lender_matches_stale = true");
  });
  it("files out to lenders are marked out of date too", () => {
    expect(readFileSync("src/repositories/lenderProducts.repo.ts", "utf8")).toContain("'Additional Steps Required','Off to Lender','Offer')");
  });
  it("out-of-date lists are recalculated when the Lenders tab opens", () => {
    const s = readFileSync("src/services/lenderMatchCache.ts", "utf8");
    expect(s).toContain("const fresh = await computeAndCacheLenderMatches(applicationId);");
    expect(s).toContain('return { status: "ready", outstanding: [], computed_at: new Date().toISOString(), matches: fresh.matches');
  });
});
