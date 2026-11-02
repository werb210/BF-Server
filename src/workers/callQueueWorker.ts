// BF_SERVER_v871_CALL_QUEUES - every 15 seconds, one instance per tick, only while someone is in a queue: offers
// whose status callback never came back go to the next person, callers past the queue's longest wait are dequeued to
// the overflow (voicemail / callback), and waiting callers are offered to whoever is free.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { sweepQueues } from "../callQueues/queues.js";

const TICK_MS = 15 * 1000;

export function startCallQueueWorker(pool: Pool): { stop: () => void } {
  const tick = claimedTick("call_queues", async () => {
    try {
      const live = await pool.query(`SELECT 1 FROM call_queue_calls WHERE status IN ('waiting', 'offered') LIMIT 1`);
      if (!live.rows.length) return;
      const r = await sweepQueues(pool);
      if (r.offers || r.overflowed || r.expired) console.log(JSON.stringify({ event: "call_queue_sweep", ...r }));
    } catch (e) {
      console.error("[call-queue-worker] tick failed", e instanceof Error ? e.message : e);
    }
  });
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  return { stop: () => clearInterval(timer) };
}
