// BF_SERVER_WIDGET_SUMMARY_v41
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_ROUTE_MOUNTS, ROUTES } from "../routeRegistry.js";
import widgetSummaryRoutes from "../widgetSummary.js";
import dashboardRoutes from "../dashboard.js";
import { ROLES } from "../../auth/roles.js";
import { ApplicationStage } from "../../modules/applications/pipelineState.js";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});

const STAFF_ID = "00000000-0000-4000-8000-0000000000a1";
const token = () => jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const PROFILE = /FROM users WHERE id = \$1/;

let inFlight = 0;
let maxInFlight = 0;
function answers() {
  const base = answerBySql([
    [PROFILE, { rows: [{ id: STAFF_ID, role: "Admin", silo: "BF", silos: ["BF", "BI"] }] }],
    [/FROM tasks t/, { rows: [{ count: "3" }] }],
    [/FROM communications_messages m/, { rows: [{ count: "2" }] }],
    [/AS commission/, { rows: [{ commission: "1234.56" }] }],
    [/SELECT COUNT\(\*\)::text AS count FROM applications a/, { rows: [{ count: "7" }] }],
  ]);
  return async (sql: unknown, params?: unknown[]) => {
    if (PROFILE.test(sqlText(sql))) return base(sql, params);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return base(sql, params);
  };
}

async function summary(withAuth = true) {
  const app = express();
  app.use("/api/widget", widgetSummaryRoutes);
  const r = request(app).get("/api/widget/summary").set("X-Silo", "BI");
  return withAuth ? r.set("Authorization", `Bearer ${token()}`) : r;
}
const widgetCalls = () => queryMock.mock.calls.filter(([sql]) => !PROFILE.test(sqlText(sql)));
const appQueries = () => widgetCalls().filter(([sql]) => /FROM applications a/.test(sqlText(sql)));
const commissionSql = () => sqlText(callsMatching(queryMock, /AS commission/)[0]![0]);

beforeEach(() => {
  inFlight = 0;
  maxInFlight = 0;
  queryMock.mockReset();
  queryMock.mockImplementation(answers());
});

describe("the widget cannot disagree with the dashboard", () => {
  async function dashboardSql(): Promise<string> {
    const app = express();
    app.use("/api/dashboard", dashboardRoutes);
    const res = await request(app).get("/api/dashboard/metrics").set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    return queryMock.mock.calls.map(([sql]) => sqlText(sql)).join("\n");
  }

  it("uses the same commission rule: 2% unless the product overrides it", async () => {
    await summary();
    const rule = "COALESCE(lp.commission, 2) / 100.0";
    expect(commissionSql()).toContain(rule);
    expect(await dashboardSql()).toContain(rule);
  });

  it("falls back through funded amount, accepted offer, then requested", async () => {
    await summary();
    const amount = "COALESCE(a.funded_amount, off.amount, a.requested_amount, 0)";
    expect(commissionSql()).toContain(amount);
    expect(await dashboardSql()).toContain(amount);
  });

  it("converts to CAD rather than summing raw currencies", async () => {
    await summary();
    expect(commissionSql()).toContain("SELECT to_cad FROM fx_rates WHERE currency = a.funded_currency");
  });

  it("counts earned commission on funded deals only", async () => {
    await summary();
    const [call] = callsMatching(queryMock, /AS commission/);
    expect(sqlText(call![0])).toContain("a.pipeline_state = $2 OR a.funded_amount IS NOT NULL");
    expect(call![1]).toEqual(["BI", ApplicationStage.ACCEPTED]);
  });
});

describe("one call, not four", () => {
  it("runs its queries together", async () => {
    await summary();
    expect(widgetCalls()).toHaveLength(4);
    expect(maxInFlight).toBe(4);
  });

  it("returns every figure the widget needs", async () => {
    const res = await summary();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ silo: "BI", pipelineCount: 7, tasksDueToday: 3, unreadMessages: 2, commissionEarned: 1235, currency: "CAD" });
  });

  it("stamps the time so a stale tile can say so", async () => {
    const before = Date.now();
    const res = await summary();
    const asOf = Date.parse(res.body.asOf);
    expect(new Date(asOf).toISOString()).toBe(res.body.asOf);
    expect(asOf).toBeGreaterThanOrEqual(before - 1000);
    expect(asOf).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("it counts what the portal counts", () => {
  it("excludes companion legs, drafts and nameless rows", async () => {
    await summary();
    for (const [sql] of appQueries()) {
      expect(sqlText(sql)).toContain("a.parent_application_id IS NULL");
      expect(sqlText(sql)).toContain("NOT IN ('draft', 'Draft', '')");
      expect(sqlText(sql)).toContain("NOT IN ('draft', 'draft application')");
    }
  });

  it("applies that definition to every application figure", async () => {
    await summary();
    expect(appQueries()).toHaveLength(2);
  });

  it("counts unread inbound messages, skipping orphaned threads", async () => {
    await summary();
    const sql = sqlText(callsMatching(queryMock, /FROM communications_messages m/)[0]![0]);
    expect(sql).toContain("m.read_at IS NULL");
    expect(sql).toContain("m.direction = 'inbound'");
    expect(sql).toContain("m.contact_id IS NOT NULL");
  });

  it("counts today's and overdue tasks, mine or unclaimed", async () => {
    await summary();
    const [call] = callsMatching(queryMock, /FROM tasks t/);
    const sql = sqlText(call![0]);
    expect(sql).toContain("t.due_at::date <= now()::date");
    expect(sql).toContain("t.assignee_user_id = $2 OR t.assignee_user_id IS NULL");
    expect(sql).toContain("t.status <> 'COMPLETED'");
    expect(call![1]).toEqual(["BI", STAFF_ID]);
  });
});

describe("it is authenticated and silo-scoped like everything else", () => {
  it("requires auth", async () => {
    const res = await summary(false);
    expect(res.status).toBe(401);
    expect(widgetCalls()).toHaveLength(0);
  });

  it("scopes every query to the caller's silo", async () => {
    await summary();
    for (const [sql, params] of widgetCalls()) {
      expect(sqlText(sql)).toMatch(/silo/i);
      expect((params as unknown[])[0]).toBe("BI");
    }
  });

  it("is mounted and registered for staff", () => {
    expect(API_ROUTE_MOUNTS.filter((m) => m.router === widgetSummaryRoutes).map((m) => m.path)).toEqual(["/widget"]);
    expect(ROUTES).toContainEqual({ method: "GET", path: "/api/widget/summary", roles: [ROLES.ADMIN, ROLES.STAFF] });
  });
});
