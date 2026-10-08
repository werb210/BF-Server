// BF_SERVER_REPORTS_BATCH2_v719
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
const calls: Array<{ sql: string; params: unknown[] }> = [];
// BF_SERVER_ONE_COMMISSION_v727 - the forecast query now returns Canadian-dollar commission per stage.
vi.mock("../db.js", () => ({ pool: { query: vi.fn(async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: sql.includes("commission_cad") ? [{ stage: "Off to Lender", files: 2, amount_cad: 100000, commission_cad: 2000 }, { stage: "In Review", files: 1, amount_cad: 50000, commission_cad: 1000 }] : [] }; }) } }));
import { revenueForecast, staffActivity, STAGE_ODDS } from "../services/reports/data2.js";
import { catalogFor, REPORTS } from "../services/reports/catalog.js";
describe("batch 2 reports", () => {
  it("the forecast weights each stage by its odds", async () => { const r = await revenueForecast(); const otl = r.stages.find((s) => s.stage === "Off to Lender")!; expect(otl.expected_commission).toBe(Math.round(2000 * STAGE_ODDS["Off to Lender"]!)); expect(otl.full_commission).toBe(2000); expect(r.stages[0].stage).toBe("Off to Lender"); });
  it("staff see only their own activity; Admins see everyone", async () => { await staffActivity({}, { role: "Staff", userId: "u1" }); expect(calls.at(-1)!.params).toEqual([7, true, "u1"]); await staffActivity({}, { role: "Admin", userId: "u2" }); expect(calls.at(-1)!.params).toEqual([7, false, "u2"]); });
  it("money reports stay Admin-only and marketing ones stay away from Staff", () => { expect(catalogFor("Marketing").map((r) => r.key)).not.toContain("revenue_forecast"); expect(catalogFor("Marketing").map((r) => r.key)).not.toContain("payouts_owed"); expect(catalogFor("Staff").map((r) => r.key)).not.toContain("monthly_cohorts"); expect(catalogFor("Staff").map((r) => r.key)).toContain("staff_activity"); });
  it("every portal-drawn card in the catalog is one the board can draw", () => { const portal = REPORTS.filter((r) => r.source === "portal").map((r) => r.key).sort(); expect(portal).toEqual(["ads_dropoff", "ads_story", "ads_visitors", "bi_dashboard", "bi_insurance"]) /* BF_SERVER_REPORTS15_18_v786 - bi_insurance */; });
  it("the data route passes who is viewing", () => { expect(readFileSync("src/routes/reportsSection.ts", "utf8")).toContain("{ role: normalizeRole(req.user?.role), userId: uid(req) }"); });
});
