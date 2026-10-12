// BF_SERVER_BLOCK_1_30B_BANKING_WORKER_TRIGGER
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  runBankingAnalysis: vi.fn(),
  storageFetch: vi.fn(),
  analyzeBankStatements: vi.fn(),
  buildBankingFromOcr: vi.fn(),
}));
vi.mock("../claim.js", () => ({ claimedTick: (_n: string, fn: () => Promise<unknown>) => async () => { await fn(); } }));
vi.mock("../../services/banking/bankingAnalysisPipeline.js", () => ({ runBankingAnalysis: (...a: unknown[]) => h.runBankingAnalysis(...a) }));
vi.mock("../../modules/ocr/ocr.storage.js", () => ({ createOcrStorage: () => ({ fetchBuffer: (...a: unknown[]) => h.storageFetch(...a) }) }));
vi.mock("../../services/bankingAnalysis.service.js", async (orig) => ({ ...(await orig() as any), analyzeBankStatements: (...a: unknown[]) => h.analyzeBankStatements(...a) }));
vi.mock("../../services/banking/bankingFromOcr.js", async (orig) => ({ ...(await orig() as any), buildBankingFromOcr: (...a: unknown[]) => h.buildBankingFromOcr(...a) }));
import { startBankingAutoWorker } from "../bankingAutoWorker.js";

const PICKUP = /SELECT DISTINCT d\.application_id::text AS application_id/;

async function tick(rows: Array<{ application_id: string }>) {
  const pool = { query: vi.fn(answerBySql([[PICKUP, { rows }]], { rows: [], rowCount: 1 })) };
  const w = startBankingAutoWorker(pool as any);
  await vi.waitFor(() => expect(callsMatching(pool.query, PICKUP)).toHaveLength(1));
  // Let every picked-up application finish (analysis, then the follow-up write).
  await vi.waitFor(() => expect(pool.query.mock.calls.length).toBeGreaterThanOrEqual(1 + rows.length));
  w.stop();
  return pool;
}

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.runBankingAnalysis.mockResolvedValue(undefined);
  h.storageFetch.mockResolvedValue(Buffer.from("pdf"));
});
afterEach(() => { vi.restoreAllMocks(); });

describe("BF_SERVER_BLOCK_1_30B_BANKING_WORKER_TRIGGER — worker contract", () => {
  it("calls runBankingAnalysis from the new pipeline", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const pool = await tick([{ application_id: "app-1" }]);
    expect(h.runBankingAnalysis).toHaveBeenCalledWith("app-1", { fetchBuffer: expect.any(Function) });
    const mirror = callsMatching(pool.query, /SET banking_status = 'completed'/);
    expect(mirror[0][1]).toEqual(["app-1"]);
  });

  it("resolves fetchBuffer via the OCR storage resolver (BF_SERVER_BLOCK_v688_BANKING_STORAGE_REF_v1)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await tick([{ application_id: "app-1" }]);
    const { fetchBuffer } = h.runBankingAnalysis.mock.calls[0][1] as { fetchBuffer: (ref: string) => Promise<Buffer> };
    expect(await fetchBuffer("azure://container/blob.pdf")).toEqual(Buffer.from("pdf"));
    expect(h.storageFetch).toHaveBeenCalledWith({ content: "azure://container/blob.pdf" });
  });

  it("gates on banking_analyses status to avoid re-runs", async () => {
    const pool = await tick([]);
    const sql = String(callsMatching(pool.query, PICKUP)[0][0]);
    expect(sql).toMatch(/ba\.status IN \([^)]*'in_progress'[^)]*\)/);
    expect(sql).toMatch(/ba\.status IN \([^)]*'analysis_complete'[^)]*\)/);
    expect(h.runBankingAnalysis).not.toHaveBeenCalled();
  });

  it("no longer calls the legacy analyzeBankStatements stub", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await tick([{ application_id: "app-1" }, { application_id: "app-2" }]);
    expect(h.runBankingAnalysis).toHaveBeenCalledTimes(2);
    expect(h.analyzeBankStatements).not.toHaveBeenCalled();
    expect(h.buildBankingFromOcr).not.toHaveBeenCalled();
  });

  it("parks failed analyses so they don't loop", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.runBankingAnalysis.mockRejectedValue(new Error("document intelligence 500"));
    const pool = await tick([{ application_id: "app-3" }]);
    const park = callsMatching(pool.query, /INSERT INTO banking_analyses/);
    expect(park).toHaveLength(1);
    expect(String(park[0][0])).toContain("VALUES ($1, 'failed', 1, 3,");
    expect(park[0][1]).toEqual(["app-3", "document intelligence 500"]);
    // and the pickup skips failed rows that are backing off or out of attempts
    const sql = String(callsMatching(pool.query, PICKUP)[0][0]);
    expect(sql).toContain("(ba.status = 'failed' AND ba.next_attempt_at > NOW())");
    expect(sql).toContain("(ba.status = 'failed' AND ba.attempt_count >= COALESCE(ba.max_attempts, 3))");
    expect(callsMatching(pool.query, /SET banking_status = 'completed'/)).toHaveLength(0);
  });
});
