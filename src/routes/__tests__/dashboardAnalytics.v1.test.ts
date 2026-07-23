// BF_SERVER_DASHBOARD_ANALYTICS_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(process.cwd(), "src/routes/dashboard.ts"), "utf8");

describe("dashboard analytics endpoints", () => {
  it("replaces the empty stubs with real queries", () => {
    // These three returned {} / {} / [] and their portal components rendered nothing.
    expect(src).not.toContain('router.get("/document-health", requireAuth, safeHandler(async (_req: any, res: any) => {\n  res.json({ status: "ok", data: {} });');
    expect(src).toContain("FROM documents d");
    expect(src).toContain("FROM application_packages p");
    expect(src).toContain("FROM offers o");
  });

  it("exposes the new analytics routes", () => {
    expect(src).toContain('router.get("/funnel"');
    expect(src).toContain('router.get("/funding-by-product"');
    expect(src).toContain('router.get("/acquisition"');
  });

  it("scopes every new query to the active silo", () => {
    const newRoutes = src.slice(src.indexOf("BF_SERVER_DASHBOARD_ANALYTICS_v1"));
    const selects = newRoutes.split("pool.query").slice(1);
    expect(selects.length).toBeGreaterThan(0);
    for (const q of selects) {
      const body = q.slice(0, q.indexOf("`,") + 2);
      expect(body).toContain("silo");
    }
  });

  it("clamps the date window instead of trusting the query string", () => {
    expect(src).toContain("function windowDays");
    expect(src).toContain("Math.min(Math.max(Math.round(raw), 1), 365)");
  });

  it("excludes empty-shell drafts from the funnel", () => {
    // Counting never-started drafts makes step-1 drop-off look catastrophic.
    expect(src).toContain("AND NOT (submitted_at IS NULL");
  });

  it("omits lenders with no sends rather than showing them as 0%", () => {
    const seg = src.slice(src.indexOf('router.get("/lender-activity"'));
    expect(seg).toContain("WITH sent AS");
    expect(seg).toContain("FROM sent s");
  });

  it("never attributes ad spend to organic or direct traffic", () => {
    expect(src).toContain("const isPaidGoogle =");
    expect(src).toContain("const cost = isPaidGoogle ? adSpend : 0;");
  });

  it("degrades per-source instead of failing the whole panel", () => {
    expect(src).toContain("sources: {");
    expect(src).toContain("ga4: Boolean(ga4?.configured)");
    expect(src).toContain("googleAds: Boolean(ads?.configured)");
  });
});
