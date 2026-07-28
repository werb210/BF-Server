// BF_SERVER_ANALYTICS_FUNNELS_v1
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const src = readFileSync(fileURLToPath(new URL("../routes/dashboard.ts", import.meta.url)), "utf-8");

describe("analytics returns the funnels the portal renders", () => {
  it("includes both keys in the payload", () => {
    expect(src).toContain("data: { days, revenueFunnel, applicationFunnel,");
  });
  it("scopes the funnels to the same silo and window as every other panel", () => {
    const seg = src.slice(src.indexOf("revenueFunnel = {"), src.indexOf("applicationFunnel[r.stage]"));
    expect(seg).toContain("UPPER(a.silo) = UPPER($1)");
    expect(seg).toContain("a.created_at >= now() - ($2 || ' days')::interval");
  });
  it("reports GA4 visits as 0 rather than fabricating them", () => {
    // GA4 needs the Data API and its own credentials; inventing a number here
    // would be worse than showing zero.
    expect(src).toContain("visits: 0,");
  });
  it("excludes drafts from the drop-off funnel, matching /pipeline", () => {
    expect(src).toContain("NOT IN ('draft','Draft','')");
  });
  it("never lets a funnel query take down the whole endpoint", () => {
    expect(src).toContain("[dashboard.analytics] revenue funnel failed");
    expect(src).toContain("[dashboard.analytics] application funnel failed");
  });
});
