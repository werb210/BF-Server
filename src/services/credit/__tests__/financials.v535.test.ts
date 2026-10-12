import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const { queryMock, createMock, docsMock } = vi.hoisted(() => ({ queryMock: vi.fn(), createMock: vi.fn(), docsMock: vi.fn() }));
vi.mock("../../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db.js");
  return { ...actual, pool: { query: queryMock } };
});
vi.mock("../../../lib/sharedClients.js", () => ({
  sharedOpenAI: () => ({ chat: { completions: { create: createMock } } }),
  sharedTwilio: () => ({ messages: { create: vi.fn() } }),
}));
vi.mock("../docKinds.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), documentsOfKinds: docsMock }));
import { buildTable, extractApplicationFinancials, normalizeExtraction, setFinancialCell } from "../financials.js";
import { API_ROUTE_MOUNTS } from "../../../routes/routeRegistry.js";
import creditFinancialsRoutes from "../../../routes/creditFinancials.js";

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([[/INSERT INTO application_financials/, { rows: [], rowCount: 1 }]]));
  createMock.mockReset();
  createMock.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ periods: [{ label: "FY2024", period_end: "2024-04-30", items: { revenue: 33455165 } }] }) } }] });
  docsMock.mockReset();
  docsMock.mockResolvedValue([{ id: "d1", name: "FS 2024.pdf", category: "financial_statements", kind: "financial_statements", ocr_text: "Revenue 33,455,165 ".repeat(20) }]);
  process.env.OPENAI_API_KEY = "sk-test";
});

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
    expect(API_ROUTE_MOUNTS.filter((m) => m.router === creditFinancialsRoutes).map((m) => m.path)).toEqual(["/credit-financials"]);
  });
  it("re-extraction only overwrites AI cells, and a staff correction is stamped as staff", async () => {
    const out = await extractApplicationFinancials("a1");
    expect(out).toEqual({ documents: 1, periods: 1, cells: 1, skipped: [] });
    const [ins] = callsMatching(queryMock, /INSERT INTO application_financials/);
    expect(ins![0]).toMatch(/'ai'[\s\S]*WHERE application_financials\.extracted_by = 'ai'/);
    expect(ins![1]).toEqual(["a1", "FY2024", "2024-04-30", "annual", "revenue", 33455165, "d1"]);
    queryMock.mockClear();
    await setFinancialCell("a1", { period: "FY2024", item: "revenue", value: 33000000 }, "u1");
    const [staff] = callsMatching(queryMock, /INSERT INTO application_financials/);
    expect(staff![0]).toContain("extracted_by = 'staff'");
    expect(staff![1]).toEqual(["a1", "FY2024", null, "annual", "revenue", 33000000, "u1"]);
  });
});
