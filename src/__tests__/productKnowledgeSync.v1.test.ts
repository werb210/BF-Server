// BF_SERVER_PRODUCT_KNOWLEDGE_SYNC_v1 - Maya's product knowledge follows lender_products,
// including products inserted by hand or by raw SQL.
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { bootIndex } from "./helpers/bootIndex.js";

const embedAndStore = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../modules/ai/knowledge.service.js", () => ({ embedAndStore: (...a: unknown[]) => embedAndStore(...a) }));
vi.mock("../workers/claim.js", () => ({ claimedTick: (_n: string, fn: () => Promise<unknown>) => async () => { await fn(); } }));
import { reconcileProductKnowledge } from "../modules/ai/productIngest.service.js";
import { startProductKnowledgeWorker } from "../workers/productKnowledgeWorker.js";

function fakePool() {
  return {
    query: vi.fn(answerBySql([
      [/from lender_products p\s+where not exists/, { rows: [{ id: "p-new" }] }],
      [/from lender_products\s+where id = \$1/, { rows: [{ id: "p-new", name: "New LOC", category: "LOC", interest_min: 8, interest_max: 12, term_min: 6, term_max: 24, country: "CA" }] }],
      [/delete from ai_knowledge/, { rows: [{ id: "k-gone" }] }],
    ])),
  };
}

afterEach(() => { vi.useRealTimers(); embedAndStore.mockClear(); });

describe("product knowledge sync", () => {
  it("adds a reconciler that ingests missing and prunes deleted products", async () => {
    const pool = fakePool();
    expect(await reconcileProductKnowledge(pool as any)).toEqual({ ingested: 1, pruned: 1 });
    expect(embedAndStore).toHaveBeenCalledWith(pool, expect.stringContaining("Product: New LOC"), "product", "p-new", "New LOC");
    const prune = callsMatching(pool.query, /delete from ai_knowledge/)[0][0] as string;
    expect(prune).toContain("source_id not in (select id from lender_products)");
  });

  it("a failed embedding skips the product and still prunes", async () => {
    embedAndStore.mockRejectedValueOnce(new Error("no OPENAI_API_KEY"));
    const pool = fakePool();
    expect(await reconcileProductKnowledge(pool as any)).toEqual({ ingested: 0, pruned: 1 });
  });

  it("the worker runs the reconciler shortly after boot", async () => {
    vi.useFakeTimers();
    const pool = fakePool();
    const w = startProductKnowledgeWorker(pool as any);
    expect(callsMatching(pool.query, /delete from ai_knowledge/)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(callsMatching(pool.query, /delete from ai_knowledge/)).toHaveLength(1);
    w.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(callsMatching(pool.query, /delete from ai_knowledge/)).toHaveLength(1);
  });

  it("starts the worker at boot", async () => {
    const boot = await bootIndex();
    try {
      await boot.workersDone();
      expect(boot.workerCalls.get("startProductKnowledgeWorker")).toEqual([[boot.pool]]);
    } finally { boot.restore(); }
  });
});
