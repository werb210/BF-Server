// BF_SERVER_BLOCK_v785_SEQUENCES — drip worker, same 30s tick pattern as the send queue.
import type { Pool } from "pg";
import { tickSequences } from "../services/sequenceEngine.js";
import { claimedTick } from "./claim.js"; // BF_SERVER_v789_WORKER_CLAIM

const TICK_MS = 30_000;

export function startSequenceWorker(pool: Pool): { stop: () => void } {
  let stopped = false, running = false;
  const tickUnclaimed = async () => {
    if (stopped || running) return;
    running = true;
    try { await tickSequences(pool); }
    catch (err) { console.error("[sequence-worker] tick failed; retrying next tick", { message: (err as Error)?.message ?? String(err) }); } // BF_SERVER_v789_WORKER_CLAIM - was a bare catch
    finally { running = false; }
  };
  const tick = claimedTick("sequences", tickUnclaimed); // BF_SERVER_v789_WORKER_CLAIM - one instance per tick
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
