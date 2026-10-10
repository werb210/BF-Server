// BF_SERVER_MAYA_FACTS_v803
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("../services/googleAdsService.js", () => ({
  runGoogleAdsReport: vi.fn(async () => ({
    configured: true, days: 30, campaigns: [
      { name: "BF - Search - Canada", status: "ENABLED", cost: 3000, clicks: 1900, impressions: 40000, cpc: 1.58, conversions: 7.5 },
      { name: "BF - Search - US", status: "ENABLED", cost: 2093, clicks: 1272, impressions: 30000, cpc: 1.65, conversions: 8.1 },
      { name: "Leads-Performance Max-1", status: "REMOVED", cost: 400, clicks: 100, impressions: 9000, cpc: 4, conversions: 0 },
    ],
  })),
}));
import { pipelineFacts, adsPerformance } from "../routes/mayaStaffInsights.js";

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
  const staff = readFileSync(fileURLToPath(new URL("../routes/mayaStaff.ts", import.meta.url)), "utf-8");
  const insights = readFileSync(fileURLToPath(new URL("../routes/mayaStaffInsights.ts", import.meta.url)), "utf-8");
  it("missed calls use call_events.occurred_at and open tasks use the live tasks table", () => {
    expect(staff).toContain("event_type = 'call.missed' AND ($1::text IS NULL OR silo = $1) AND occurred_at > now()");
    expect(staff).not.toContain("FROM crm_tasks WHERE ($1::text IS NULL OR silo = $1)");
  });
  it("comms overview compares conferences.contact_id as text", () => {
    expect(insights).toContain("LEFT JOIN contacts c ON c.id::text = cf.contact_id");
  });
  it("application summary can be found by name or short id", () => {
    expect(staff).toContain('const lookup = typeof req.body?.name === "string"');
    expect(staff).toContain("sentToLenders");
  });
});
