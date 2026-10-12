// BF_SERVER_BI_HANDOFF_RETRY_v397
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { bootIndex } from "./helpers/bootIndex.js";

const query = vi.fn();
vi.mock("../db.js", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
import { MAX_ATTEMPTS, retryMissingBiHandoffs, type RetryDeps } from "../services/biHandoffRetry.js";

function deps(sendResults: any[]): RetryDeps & { calls: Record<string, any[]> } {
  const calls: Record<string, any[]> = { success: [], failure: [], mirror: [], send: [] };
  let index = 0;
  return {
    calls,
    findPending: async () => [
      { id: "app-1", form: { pgi_opt_in: "yes" } },
      { id: "app-2", form: { pgi_opt_in: "yes" } },
    ],
    send: vi.fn(async (input: any) => {
      calls.send.push(input);
      const result = sendResults[index++];
      if (result instanceof Error) throw result;
      return result;
    }) as any,
    recordSuccess: async (id, result) => { calls.success.push([id, result]); },
    recordFailure: async (id, error) => { calls.failure.push([id, error]); },
    mirrorDocs: async (id) => { calls.mirror.push(id); },
  };
}

describe("PGI applications that never reached BI are retried automatically", () => {
  it("links the ones BI accepts and copies their documents", async () => {
    const d = deps([
      { ok: true, biApplicationId: "bi-1", biPublicId: "pub-1", completionUrl: "https://x" },
      { ok: false, error: "bi_500" },
    ]);
    const result = await retryMissingBiHandoffs(20, d);
    expect(result).toEqual({ tried: 2, linked: 1, failed: 1 });
    expect(d.calls.send[0]).toEqual({ bfApplicationId: "app-1", legacyApp: { pgi_opt_in: "yes" } });
    expect(d.calls.success[0][0]).toBe("app-1");
    expect(d.calls.mirror).toEqual(["app-1"]);
    expect(d.calls.failure).toEqual([["app-2", "bi_500"]]);
  });

  it("records a thrown error without stopping later retries", async () => {
    const d = deps([
      new Error("network down"),
      { ok: true, biApplicationId: "b", biPublicId: "p", completionUrl: "u" },
    ]);
    const result = await retryMissingBiHandoffs(20, d);
    expect(result.linked).toBe(1);
    expect(d.calls.failure[0]).toEqual(["app-1", "network down"]);
  });

  it("only picks submitted, PGI-opted, unlinked BF applications, with a retry limit and spacing", async () => {
    query.mockReset();
    query.mockImplementation(answerBySql([]));
    const result = await retryMissingBiHandoffs(7);
    expect(result).toEqual({ tried: 0, linked: 0, failed: 0 });
    const [sql, params] = callsMatching(query, /FROM applications/)[0] as [string, unknown[]];
    expect(sql).toContain("AND bi_application_id IS NULL");
    expect(sql).toContain("AND metadata->>'submittedAt' IS NOT NULL");
    expect(sql).toContain("= 'yes'");
    expect(sql).toContain("COALESCE((metadata->>'bi_handoff_attempts')::int, 0) < $2");
    expect(sql).toContain("interval '30 minutes'");
    expect(params).toEqual([7, MAX_ATTEMPTS]);
  });

  it("starts with the server (no arguments)", async () => {
    const boot = await bootIndex();
    try {
      await boot.workersDone();
      expect(boot.workerCalls.get("startBiHandoffRetryWorker")).toEqual([[]]);
    } finally { boot.restore(); }
  });
});
