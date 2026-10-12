// BF_SERVER_ADS_WAREHOUSE_v1
// Snapshots Google Ads metrics into google_ads_daily so ad history is owned locally
// rather than re-fetched (and lost) on every restart. Runs ~60s after startup, then
// every 6 hours. Re-snapshots a trailing window so late-arriving conversions are
// picked up. Non-overlapping; never throws.
import type { Pool } from "pg";
import { snapshotGoogleAds } from "../services/googleAdsWarehouse.js";
import { claimedTick } from "./claim.js"; // BF_SERVER_v789_WORKER_CLAIM

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const KICKOFF_MS = 60 * 1000;
const WINDOW_DAYS = 30;

export function startGoogleAdsWarehouseWorker(pool: Pool): { stop: () => void } {
  let running = false;

  const tickUnclaimed = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const out = await snapshotGoogleAds(pool, WINDOW_DAYS);
      if (out.rows) console.log(`[ads-warehouse] snapshotted ${out.rows} rows`);
    } catch (err) {
      console.error("[ads-warehouse] snapshot failed:", (err as { message?: string })?.message ?? err);
    } finally {
      running = false;
    }
  };
  const tick = claimedTick("google_ads_warehouse", tickUnclaimed); // BF_SERVER_v789_WORKER_CLAIM - one instance per tick

  const kickoff = setTimeout(() => { void tick(); }, KICKOFF_MS);
  const timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  return { stop: () => { clearTimeout(kickoff); clearInterval(timer); } };
}
