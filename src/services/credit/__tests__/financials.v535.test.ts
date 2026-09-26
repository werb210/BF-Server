import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
vi.mock("../../../db.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));
import { buildTable, normalizeExtraction, setFinancialCell } from "../financials.js";

const cell = (period: string, line_item: string, value: number, kind: "annual" | "interim" | "forecast" = "annual", period_end: string | null = null) =>
  ({ period, period_end, kind, line_item, value, source_document_id: "d1", edited_by: null });

describe("v535 financial extraction", () => {
  it("normalizes known numeric line items", () => {
    const periods = normalizeExtraction({ periods: [{ label: "FY2024", period_end: "2024-04-30", items: { revenue: "$33,455,165", net_income: "(12,500)", unknown: 2 } }] });
    expect(periods[0]!.items).toEqual({ revenue: 33455165, net_income: -12500 });
    expect(normalizeExtraction(null)).toEqual([]);
  });
  it("calculates ratios and orders annual periods before interim periods", () => {
    const table = buildTable([
      cell("Interim 2024", "net_income", 600000, "interim"), cell("Interim 2024", "depreciation_amortization", 52397, "interim"), cell("Interim 2024", "cpltd", 441816, "interim"), cell("Interim 2024", "rent_expense", 249396, "interim"),
      cell("FY2022", "net_income", 90000, "annual", "2022-12-31"), cell("FY2022", "depreciation_amortization", 12118), cell("FY2022", "cpltd", 45321),
    ]);
    const row = (item: string) => table.rows.find((candidate) => candidate.item === item)!.values;
    expect(table.periods.map(({ label }) => label)).toEqual(["FY2022", "Interim 2024"]);
    expect(row("ebitda")).toEqual([102118, 652397]);
    expect(row("dscr")).toEqual([2.25, 1.48]);
    expect(row("ebitda_plus_rent")).toEqual([null, 901793]);
  });
  it("derives gross margin", () => {
    const table = buildTable([cell("FY2024", "revenue", 11556700), cell("FY2024", "cost_of_sales", 7465545)]);
    expect(table.rows.find(({ item }) => item === "gross_margin")!.values).toEqual([4091155]);
  });
  it("rejects invalid corrections and mounts the route", async () => {
    await expect(setFinancialCell("a1", { period: "FY2024", item: "vibes", value: 1 }, "u1")).rejects.toThrow("unknown_line_item");
    await expect(setFinancialCell("a1", { period: " ", item: "revenue", value: 1 }, "u1")).rejects.toThrow("period_required");
    expect(fs.readFileSync("src/routes/routeRegistry.ts", "utf8")).toMatch(/path: "\/credit-financials", router: creditFinancialsRoutes/);
    expect(fs.readFileSync("src/services/credit/financials.ts", "utf8")).toContain("WHERE application_financials.extracted_by = 'ai'");
  });
});
