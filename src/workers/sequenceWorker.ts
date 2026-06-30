// BF_SERVER_BLOCK_v785_SEQUENCES — drip worker, same 30s tick pattern as the send queue.
import type { Pool } from "pg";
import { tickSequences } from "../services/sequenceEngine.js";

const TICK_MS = 30_000;

export function startSequenceWorker(pool: Pool): { stop: () => void } {
  let stopped = false, running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try { await tickSequences(pool); } catch { /* next tick */ } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
