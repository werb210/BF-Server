// BF_SERVER_WIDGET_SUMMARY_v41
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const widget = read("src/routes/widgetSummary.ts");
const dashboard = read("src/routes/dashboard.ts");
const registry = read("src/routes/routeRegistry.ts");

describe("the widget cannot disagree with the dashboard", () => {
  it("uses the same commission rule: 2% unless the product overrides it", () => {
    const rule = "COALESCE(lp.commission, 2) / 100.0";
    expect(widget).toContain(rule);
    expect(dashboard).toContain(rule);
  });

  it("falls back through funded amount, accepted offer, then requested", () => {
    const amount = "COALESCE(a.funded_amount, off.amount, a.requested_amount, 0)";
    expect(widget).toContain(amount);
    expect(dashboard).toContain(amount);
  });

  it("converts to CAD rather than summing raw currencies", () => {
    expect(widget).toContain("SELECT to_cad FROM fx_rates WHERE currency = a.funded_currency");
  });

  it("counts earned commission on funded deals only", () => {
    expect(widget).toContain("a.pipeline_state = $2 OR a.funded_amount IS NOT NULL");
  });
});

describe("one call, not four", () => {
  it("runs its queries together", () => {
    expect(widget).toContain("await Promise.all([");
    expect((widget.match(/pool.query\</g) || []).length).toBe(4);
  });

  it("returns every figure the widget needs", () => {
    for (const key of ["pipelineCount", "tasksDueToday", "unreadMessages", "commissionEarned"]) {
      expect(widget).toContain(`${key}:`);
    }
  });

  it("stamps the time so a stale tile can say so", () => {
    expect(widget).toContain("asOf: new Date().toISOString()");
  });
});

describe("it counts what the portal counts", () => {
  it("excludes companion legs, drafts and nameless rows", () => {
    expect(widget).toContain("a.parent_application_id IS NULL");
    expect(widget).toContain("NOT IN ('draft', 'Draft', '')");
    expect(widget).toContain("NOT IN ('draft', 'draft application')");
  });

  it("applies that definition to every application figure", () => {
    expect((widget.match(/\$\{REAL_DEAL\}/g) || []).length).toBe(2);
  });

  it("counts unread inbound messages, skipping orphaned threads", () => {
    expect(widget).toContain("m.read_at IS NULL");
    expect(widget).toContain("m.direction = 'inbound'");
    expect(widget).toContain("m.contact_id IS NOT NULL");
  });

  it("counts today's and overdue tasks, mine or unclaimed", () => {
    expect(widget).toContain("t.due_at::date <= now()::date");
    expect(widget).toContain("t.assignee_user_id = $2 OR t.assignee_user_id IS NULL");
    expect(widget).toContain("t.status <> 'COMPLETED'");
  });
});

describe("it is authenticated and silo-scoped like everything else", () => {
  it("requires auth", () => {
    expect(widget).toContain('router.get("/summary", requireAuth,');
  });

  it("scopes every query to the caller's silo", () => {
    expect((widget.match(/silo/gi) || []).length).toBeGreaterThan(5);
    expect(widget).toContain("const silo = getSilo(res);");
  });

  it("is mounted and registered for staff", () => {
    expect(registry).toContain('{ path: "/widget", router: widgetSummaryRoutes }');
    expect(registry).toContain('path: "/api/widget/summary", roles: [ROLES.ADMIN, ROLES.STAFF]');
  });
});
