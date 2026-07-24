// BF_SERVER_DASHBOARD_ANALYTICS_AGGREGATE_v1
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(process.cwd(), "src/routes/dashboard.ts"), "utf8");
const aggregate = src.slice(
  src.indexOf("BF_SERVER_DASHBOARD_ANALYTICS_AGGREGATE_v1"),
  src.indexOf("BF_SERVER_BLOCK_v822_DASHBOARD_PIPELINE_ACTIONS — real silo-scoped pipeline counts"),
);

describe("dashboard analytics aggregate endpoint", () => {
  it("adds the endpoint requested by DashboardAnalytics without removing split endpoints", () => {
    expect(src).toContain('router.get("/analytics"');
    expect(src).toContain('router.get("/funnel"');
    expect(src).toContain('router.get("/funding-by-product"');
    expect(src).toContain('router.get("/acquisition"');
    expect(src).toContain('router.get("/document-health"');
    expect(src).toContain('router.get("/lender-activity"');
  });

  it("pins the row fields consumed by the dashboard component", () => {
    expect(aggregate).toContain("applications: parseInt(x.applications, 10) || 0");
    expect(aggregate).toContain("revenue: Math.round((Number(x.revenue) || 0) * 100) / 100");
    expect(aggregate).toContain("funded: parseInt(x.funded, 10) || 0");
    expect(aggregate).toContain("issueRate: total > 0 ? Math.round((issues / total) * 1000) / 10 : 0");
    expect(aggregate).toContain("approvalRate: sent > 0 ? Math.round((approved / sent) * 1000) / 10 : 0");
  });

  it("keeps aggregate queries silo-scoped and windowed", () => {
    expect(aggregate).toContain("const silo = getSilo(res)");
    expect(aggregate).toContain("const days = windowDays(req)");
    const queries = aggregate.split("pool.query").slice(1);
    expect(queries.length).toBe(5);
    for (const query of queries) {
      expect(query).toContain("silo");
      expect(query).toContain("days");
    }
  });
});
