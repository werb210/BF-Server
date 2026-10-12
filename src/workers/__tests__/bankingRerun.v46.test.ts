// BF_SERVER_BANKING_RERUN_v46
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

vi.mock("../claim.js", () => ({ claimedTick: (_n: string, fn: () => Promise<unknown>) => async () => { await fn(); } }));
vi.mock("../../services/banking/bankingAnalysisPipeline.js", () => ({ runBankingAnalysis: async () => undefined }));
import { startBankingAutoWorker } from "../bankingAutoWorker.js";

const PICKUP = /SELECT DISTINCT d\.application_id::text AS application_id/;

async function pickupSql(): Promise<string> {
  const pool = { query: vi.fn(answerBySql([[PICKUP, { rows: [] }]])) };
  const w = startBankingAutoWorker(pool as any);
  await vi.waitFor(() => expect(callsMatching(pool.query, PICKUP)).toHaveLength(1));
  w.stop();
  return String(callsMatching(pool.query, PICKUP)[0][0]);
}

describe("banking auto worker pickup", () => {
  it("treats needs_review as terminal so a flagged run does not loop", async () => {
    expect(await pickupSql()).toMatch(/status IN \('in_progress', 'analysis_complete', 'needs_review'\)/);
  });

  it("still leaves pending rows for the worker to pick up, which is how retry works", async () => {
    const excluded = (await pickupSql()).match(/status IN \(([^)]*)\)/)?.[1] ?? "";
    expect(excluded).not.toBe("");
    expect(excluded).not.toContain("pending");
  });
});
