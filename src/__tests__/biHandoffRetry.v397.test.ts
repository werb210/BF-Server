// BF_SERVER_BI_HANDOFF_RETRY_v397
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { retryMissingBiHandoffs, type RetryDeps } from "../services/biHandoffRetry.js";

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

  it("only picks submitted, PGI-opted, unlinked BF applications, with a retry limit and spacing", () => {
    const source = readFileSync(path.join(process.cwd(), "src/services/biHandoffRetry.ts"), "utf8");
    expect(source).toContain("AND bi_application_id IS NULL");
    expect(source).toContain("AND metadata->>'submittedAt' IS NOT NULL");
    expect(source).toContain("= 'yes'");
    expect(source).toContain("COALESCE((metadata->>'bi_handoff_attempts')::int, 0) < $2");
    expect(source).toContain("interval '30 minutes'");
  });

  it("starts with the server", () => {
    const index = readFileSync(path.join(process.cwd(), "src/index.ts"), "utf8");
    expect(index).toContain("startBiHandoffRetryWorker()");
  });
});
