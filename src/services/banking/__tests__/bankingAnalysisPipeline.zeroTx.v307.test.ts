// BF_SERVER_BLOCK_v307_BANKING_ZERO_TX_GUARD_v1
// BF_SERVER_v789_ZERO_TX_TESTS - the three former it.todo entries, now run against the real pipeline with the
// database answered by SQL text (answerBySql) and the OCR provider answered by the model asked for.
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const { queryMock, analyzeWithDocIntelMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  analyzeWithDocIntelMock: vi.fn(),
}));

vi.mock("../../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db.js");
  return { ...actual, pool: { query: queryMock } };
});

vi.mock("../../../modules/ocr/azureDocIntelProvider.js", () => ({
  analyzeWithDocIntel: analyzeWithDocIntelMock,
}));

const APP_ID = "app-zero-1";

// OCR that finds nothing usable on either model: no tables, no transactions.
const EMPTY_OCR = { documents: [{ docType: "OTHER" }], pages: [], tables: [] };

// OCR whose bank-statement model yields one dated deposit.
const STATEMENT_OCR = {
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
};

const MARK_FAILED = /UPDATE banking_analyses\s+SET status = 'failed'/;
const MARK_COMPLETE = /UPDATE banking_analyses SET status = 'analysis_complete'/;
const BANKING_COMPLETED_AT = /banking_completed_at/;

function answerDb() {
  queryMock.mockImplementation(answerBySql([
    [/SELECT metadata FROM applications/, { rows: [{ metadata: { country: "US" } }] }],
    [/FROM documents d/, { rows: [{ id: "doc-1", storage_key: "bank.pdf", file_name: "bank.pdf" }] }],
    [/SELECT COUNT\(\*\)::text AS months/, { rows: [{ months: "1", total_deposits: "100", total_withdrawals: "0", avg_balance: null, period_start: "2026-01-01", period_end: "2026-01-01", nsf_total: "0", months_profitable: "1" }] }],
    // The reconciliation gate: one transaction whose amount ties to the balance movement.
    [/AS n_bal/, { rows: [{ n: 1, n_bal: 1, net_flow: "100", gross_flow: "100", opening: "0", closing: "100" }] }],
  ]));
}

async function run() {
  const { runBankingAnalysis } = await import("../bankingAnalysisPipeline.js");
  return runBankingAnalysis(APP_ID, { fetchBuffer: async () => Buffer.from("pdf") });
}

describe("Banking pipeline zero-tx guard", () => {
  beforeEach(() => {
    queryMock.mockReset();
    analyzeWithDocIntelMock.mockReset();
    delete process.env.OPENAI_API_KEY;
    answerDb();
  });

  it("writes status='failed' with last_error when 0 transactions extracted", async () => {
    analyzeWithDocIntelMock.mockImplementation(async () => EMPTY_OCR);

    const result = await run();

    expect(result.transaction_count).toBe(0);
    const failed = callsMatching(queryMock, MARK_FAILED);
    expect(failed).toHaveLength(1);
    const [, params] = failed[0] as [string, unknown[]];
    expect(params[0]).toBe(APP_ID);
    expect(typeof params[1]).toBe("string");
    expect(String(params[1]).length).toBeGreaterThan(0);
    // The failure reason surfaced to staff is the per-document error, not an empty string.
    expect(params[1]).toBe(result.documents[0].error);
    // ...and it is never followed by the explicit 'analysis_complete' status update.
    expect(callsMatching(queryMock, MARK_COMPLETE)).toHaveLength(0);
    // The failed status is written after the analysis row was persisted, so it is the final status.
    const persistIdx = queryMock.mock.calls.findIndex((c) => /INSERT INTO banking_analyses \(application_id, accounts/.test(String(c[0])));
    const failedIdx = queryMock.mock.calls.findIndex((c) => MARK_FAILED.test(String(c[0])));
    expect(persistIdx).toBeGreaterThanOrEqual(0);
    expect(failedIdx).toBeGreaterThan(persistIdx);
  });

  it("does not touch applications.banking_completed_at on zero-tx", async () => {
    analyzeWithDocIntelMock.mockImplementation(async () => EMPTY_OCR);

    await run();

    expect(callsMatching(queryMock, MARK_FAILED)).toHaveLength(1);
    expect(callsMatching(queryMock, BANKING_COMPLETED_AT)).toHaveLength(0);
    // Nothing was extracted, so no transactions are inserted either.
    expect(callsMatching(queryMock, /INSERT INTO banking_transactions/)).toHaveLength(0);
  });

  it("still writes 'analysis_complete' when transactions > 0", async () => {
    analyzeWithDocIntelMock.mockImplementation(async (_buf: Buffer, model: string) =>
      (model === "prebuilt-bankStatement.us" ? STATEMENT_OCR : EMPTY_OCR));

    const result = await run();

    expect(result.transaction_count).toBe(1);
    expect(callsMatching(queryMock, /INSERT INTO banking_transactions/)).toHaveLength(1);
    const complete = callsMatching(queryMock, MARK_COMPLETE);
    expect(complete).toHaveLength(1);
    expect(complete[0]![1]).toEqual([APP_ID]);
    const completedAt = callsMatching(queryMock, /UPDATE applications SET banking_completed_at = now\(\)/);
    expect(completedAt).toHaveLength(1);
    expect(completedAt[0]![1]).toEqual([APP_ID]);
    expect(callsMatching(queryMock, MARK_FAILED)).toHaveLength(0);
  });
});
