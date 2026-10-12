// BF_SERVER_MAYA_FACTS_v803
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

vi.mock("../services/googleAdsService.js", () => ({
  runGoogleAdsReport: vi.fn(async () => ({
    configured: true, days: 30, campaigns: [
      { name: "BF - Search - Canada", status: "ENABLED", cost: 3000, clicks: 1900, impressions: 40000, cpc: 1.58, conversions: 7.5 },
      { name: "BF - Search - US", status: "ENABLED", cost: 2093, clicks: 1272, impressions: 30000, cpc: 1.65, conversions: 8.1 },
      { name: "Leads-Performance Max-1", status: "REMOVED", cost: 400, clicks: 100, impressions: 9000, cpc: 4, conversions: 0 },
    ],
  })),
}));
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock } };
});
vi.mock("../routes/clientDocumentsNeeded.js", () => ({
  computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }),
}));
import { pipelineFacts, adsPerformance, commsOverview } from "../routes/mayaStaffInsights.js";
import mayaStaff from "../routes/mayaStaff.js";

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const APPS = [
  { id: "aaaa-1111", name: "TEST - Todd's Grocery Store", stage: "Off to Lender", requested_amount: "1000000", currency: "USD", product: "SBA", submitted_at: day(1), created_at: day(2), stage_since: day(1), commission_pct: 2 },
  { id: "bbbb-2222", name: "BIBUSA CN LLC", stage: "Documents Required", requested_amount: "1700", currency: "USD", product: "TERM", submitted_at: day(1), created_at: day(1), stage_since: day(1), commission_pct: 2 },
  { id: "cccc-3333", name: "Northern Gateway Films", stage: "In Review", requested_amount: "4200000", currency: "CAD", product: "MEDIA", submitted_at: day(20), created_at: day(21), stage_since: day(5), commission_pct: 2 },
  { id: "dddd-4444", name: "Creek View Farms", stage: "Rejected", requested_amount: "50000", currency: "CAD", product: "TERM", submitted_at: day(90), created_at: day(91), stage_since: day(30), commission_pct: 2 },
  { id: "eeee-5555", name: "Paused Co", stage: "Hold", requested_amount: "20000", currency: "CAD", product: "LOC", submitted_at: day(40), created_at: day(41), stage_since: day(10), commission_pct: 2 },
];
const sqlSeen: string[] = [];
const q = async (sql: string) => {
  sqlSeen.push(sql);
  if (sql.includes("FROM applications a")) return { rows: APPS };
  if (sql.includes("FROM lenders")) return { rows: Array.from({ length: 114 }, (_, i) => ({ name: "Lender " + i })) };
  return { rows: [] };
};

describe("staff Maya pipeline facts use the Dashboard rules", () => {
  it("counts no drafts, keeps Rejected/Hold out of active, and reports 0 funded", async () => {
    const f: any = await pipelineFacts(q, "BF", false);
    expect(sqlSeen.find((s) => s.includes("FROM applications a"))).toContain("NOT IN ('draft', 'Draft', '')");
    expect(f.active_count).toBe(3);
    expect(f.funded_this_month).toBe(0);
    expect(f.lender_count).toBe(114);
    expect(f.largest_active_application.name).toBe("Northern Gateway Films");
    expect(f.oldest_active_application.name).toBe("Northern Gateway Films");
    expect(f.newest_application.name).toBe("TEST - Todd's Grocery Store");
    expect(f.by_stage["Documents Required"].applications[0].name).toBe("BIBUSA CN LLC");
    expect(f.pipeline_value_by_currency).toEqual({ USD: 1001700, CAD: 4200000 });
    expect(typeof f.commission).toBe("string");
  });
  it("gives commission to Admin staff", async () => {
    const f: any = await pipelineFacts(q, "BF", true);
    expect(f.commission.by_stage["Off to Lender"].USD).toBe(20000);
  });
});

describe("staff Maya ad numbers come from the live Google Ads report", () => {
  it("matches the Ads page and leaves the removed Performance Max campaign out", async () => {
    const r: any = await adsPerformance(async () => ({ rows: [] }), 30);
    expect(r.campaigns.map((c: any) => c.campaign)).toEqual(["BF - Search - Canada", "BF - Search - US"]);
    expect(r.totals.spend).toBe(5093);
    expect(r.totals.clicks).toBe(3172);
    expect(r.campaigns[0].cost_per_conversion).toBe(400);
    expect(r.not_in_this_data).toContain("campaign budgets");
  });
});

describe("server errors from the log stream are fixed", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/maya", mayaStaff);
  const svc = () => "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
  const post = (p: string, body: Record<string, unknown>) => request(app).post("/api/maya" + p).set("Authorization", svc()).send(body);
  const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaa1234bbbb";

  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([
      // The columns and tables production does not have fail the way Postgres fails them.
      [/crm_tasks/, new Error('relation "crm_tasks" does not exist')],
      [/FROM call_events[\s\S]*created_at > now\(\)/, new Error('column "created_at" does not exist')],
      [/FROM call_events WHERE event_type = 'call.missed'/, { rows: [{ n: 3 }] }],
      [/FROM tasks WHERE/, { rows: [{ n: 4 }] }],
      [/FROM application_tasks t/, { rows: [{ n: 2 }] }],
    ]));
  });

  it("missed calls use call_events.occurred_at and open tasks use the live tasks table", async () => {
    const r = await post("/staff/daily-briefing", { silo: "BF" });
    expect(r.status).toBe(200);
    expect(r.body.counts.recentMissedCalls).toBe(3);
    expect(r.body.counts.openTasks).toBe(6);
    const [missed] = callsMatching(queryMock, /FROM call_events/);
    expect(sqlText(missed[0])).toContain("event_type = 'call.missed' AND ($1::text IS NULL OR silo = $1) AND occurred_at > now()");
    expect(missed[1]).toEqual(["BF"]);
    expect(sqlText(callsMatching(queryMock, /FROM tasks WHERE/)[0][0])).toContain("status NOT IN ('COMPLETED', 'DEFERRED')");
    expect(callsMatching(queryMock, /crm_tasks/)).toHaveLength(0);
    expect(r.body.summary).toContain("3 recent missed call(s)");
    expect(r.body.summary).toContain("6 open task(s)");
  });

  it("comms overview compares conferences.contact_id as text", async () => {
    const seen: string[] = [];
    const q = async (sql: string) => {
      seen.push(sql);
      if (sql.includes("FROM conferences cf")) {
        // conferences.contact_id is TEXT; a uuid = text comparison is a Postgres error.
        if (!sql.includes("c.id::text = cf.contact_id")) throw new Error("operator does not exist: uuid = text");
        return { rows: [{ started_at: "2026-10-01", direction: "inbound", name: "Todd W", contact_id: "c1", summary: "Asked about rates" }] };
      }
      return { rows: [] };
    };
    const out: any = await commsOverview(q, "BF", null);
    expect(out.recent_calls).toEqual([{ started_at: "2026-10-01", direction: "inbound", name: "Todd W", contact_id: "c1", summary: "Asked about rates" }]);
    expect(seen.find((s) => s.includes("FROM conferences cf"))).toContain("LEFT JOIN contacts c ON c.id::text = cf.contact_id");
  });

  it("application summary can be found by name or short id", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT a.id::text AS id FROM applications a/, (_s: string, p?: unknown[]) => ({
        rows: (p?.[0] === "%BIBUSA%" || String(p?.[1]).toUpperCase() === "1234BBBB") ? [{ id: APP_ID }] : [],
      })],
      [/FROM applications WHERE id::text = \$1 LIMIT 1/, (_s: string, p?: unknown[]) => ({
        rows: p?.[0] === APP_ID ? [{ id: APP_ID, name: "BIBUSA CN LLC", pipeline_state: "Off to Lender", created_at: "2026-10-01", currency: "USD" }] : [],
      })],
      [/FROM lender_submissions ls/, { rows: [{ lender: "Bank A", status: "submitted", sent_at: "2026-10-02" }] }],
    ]));
    const byName = await post("/staff/application-summary", { name: "BIBUSA" });
    expect(byName.status).toBe(200);
    expect(byName.body.summary.applicationId).toBe(APP_ID);
    expect(byName.body.summary.sentToLenders).toEqual([{ lender: "Bank A", status: "submitted", sentAt: "2026-10-02" }]);
    const lookup = callsMatching(queryMock, /SELECT a.id::text AS id FROM applications a/);
    expect(lookup[0][1]).toEqual(["%BIBUSA%", "BIBUSA", "BF"]);

    const byShortId = await post("/staff/application-summary", { name: "#1234bbbb" });
    expect(byShortId.status).toBe(200);
    expect(byShortId.body.summary.shortId).toBe("1234BBBB");

    const none = await post("/staff/application-summary", { name: "Nobody Inc" });
    expect(none.status).toBe(404);
    expect(none.body.error).toBe("not_found");
  });
});
