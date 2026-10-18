// BF_SERVER_v823_LIVE_ACTIVITY - every two minutes, push the application stage to the client app's lock screen
// (iPhone Live Activity / Android status notification) when it changed. One instance per tick.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { runStatusSweep } from "../services/clientStatus/applicationStatusLive.js";

const TICK_MS = 2 * 60 * 1000;

export function startClientStatusWorker(_pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;
  const tickUnclaimed = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const sent = await runStatusSweep();
      if (sent > 0) console.log("[client_status] sent", JSON.stringify({ sent }));
    } catch (error) {
      console.warn("[client_status] tick failed", error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };
  const tick = claimedTick("client_status", tickUnclaimed);
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
