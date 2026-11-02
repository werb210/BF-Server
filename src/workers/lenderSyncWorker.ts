// BF_SERVER_v873_LENDER_API - every minute (one instance per tick): retry API submissions that failed with a retryable
// error, then poll lender APIs for deals that are due (each connection's interval, 30 minutes by default; funded deals
// once a day for their balance). Webhooks make most polls unnecessary; polling is the fallback for lenders without them.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import type { Q } from "../settingsPack/common.js";

export function startLenderSyncWorker(pool: Pool, intervalMs = 60_000): { stop: () => void } {
  let stopped = false;
  let running = false;
  const tickUnclaimed = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const { pollDue, retryDue } = await import("../lenderConnectors/poll.js");
      await retryDue(pool);
      await pollDue(pool as unknown as Q);
    } catch (err: any) {
      // Before the migration has run the tables are missing: quiet until they exist.
      if (err?.code !== "42P01") console.error("[lender-sync] worker tick failed", { message: err?.message ?? String(err) });
    } finally {
      running = false;
    }
  };
  const tick = claimedTick("lender-sync", tickUnclaimed);
  const timer = setInterval(() => void tick(), intervalMs);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
