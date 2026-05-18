import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, analyzeWithDocIntelMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  analyzeWithDocIntelMock: vi.fn(),
}));

vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: queryMock } };
});

vi.mock("../../modules/ocr/azureDocIntelProvider.js", () => ({
  analyzeWithDocIntel: analyzeWithDocIntelMock,
}));

describe("banking analysis pipeline", () => {
  beforeEach(() => {
    queryMock.mockReset();
    analyzeWithDocIntelMock.mockReset();
    delete process.env.OPENAI_API_KEY;
  });

  it("falls back to prebuilt-bankStatement.us when prebuilt-layout returns OTHER", async () => {
    analyzeWithDocIntelMock
      .mockResolvedValueOnce({ documents: [{ docType: "OTHER" }], pages: [], tables: [] })
      .mockResolvedValueOnce({
        documents: [{ docType: "bankStatement.us" }],
        pages: [{ pageNumber: 1 }],
        tables: [{
          boundingRegions: [{ pageNumber: 1 }],
          cells: [
            { rowIndex: 0, columnIndex: 0, content: "Date" },
            { rowIndex: 0, columnIndex: 1, content: "Description" },
            { rowIndex: 0, columnIndex: 2, content: "Amount" },
            { rowIndex: 1, columnIndex: 0, content: "01/02/2026" },
            { rowIndex: 1, columnIndex: 1, content: "Deposit" },
            { rowIndex: 1, columnIndex: 2, content: "$100.00" },
          ],
        }],
      });

    const persistedAccounts: string[] = [];
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT metadata FROM applications")) return { rows: [{ metadata: { country: "US" } }] };
      if (sql.includes("FROM documents d")) return { rows: [{ id: "doc-1", storage_key: "bank.pdf", file_name: "bank.pdf" }] };
      if (sql.includes("INSERT INTO banking_transactions")) return { rows: [] };
      if (sql.includes("WITH month_buckets AS")) return { rows: [] };
      if (sql.includes("SELECT COUNT(*)::text AS months")) return { rows: [{ months: "1", total_deposits: "100", total_withdrawals: "0", avg_balance: null, period_start: "2026-01-01", period_end: "2026-01-01", nsf_total: "0", months_profitable: "1" }] };
      if (sql.includes("INSERT INTO banking_analyses") && params?.[1]) persistedAccounts.push(String(params[1]));
      return { rows: [] };
    });

    const { runBankingAnalysis } = await import("../banking/bankingAnalysisPipeline.js");
    const result = await runBankingAnalysis("app-1", { fetchBuffer: async () => Buffer.from("pdf") });

    expect(analyzeWithDocIntelMock).toHaveBeenNthCalledWith(1, expect.any(Buffer), "prebuilt-layout");
    expect(analyzeWithDocIntelMock).toHaveBeenNthCalledWith(2, expect.any(Buffer), "prebuilt-bankStatement.us");
    expect(result.documents[0]).toMatchObject({ model_used: "prebuilt-bankStatement.us", transaction_count: 1, fallback_used: true });
    expect(persistedAccounts.length).toBeGreaterThan(0);
    const accounts = JSON.parse(persistedAccounts.at(-1) ?? "[]");
    expect(accounts[1].documentStatuses[0]).toMatchObject({
      model_used: "prebuilt-bankStatement.us",
      detected_type: "BANKSTATEMENT.US",
      transaction_count: 1,
      fallback_used: true,
    });
  });
});
