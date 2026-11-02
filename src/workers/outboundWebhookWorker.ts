// BF_SERVER_v875_WEBHOOKS (ported from KS-server #39) - sends due webhook deliveries every 10 seconds (one instance per
// tick, so batches form from what is due together) and prunes the delivery log to 30 days once an hour.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import type { Q } from "../settingsPack/common.js";

export function startOutboundWebhookWorker(pool: Pool, intervalMs = 10_000): { stop: () => void } {
  let stopped = false;
  let lastPrune = 0;
  const tick = claimedTick("outbound_webhooks", async () => {
    if (stopped) return;
    try {
      const { CLAIM_LIMIT, httpsTransport, pruneOld, runDueDeliveries } = await import("../outboundWebhooks/deliver.js");
      const db = pool as unknown as Q;
      const transport = httpsTransport();
      let n = 0;
      let rounds = 0;
      do { n = await runDueDeliveries(db, { transport }); rounds += 1; } while (n === CLAIM_LIMIT && rounds < 5 && !stopped);
      if (Date.now() - lastPrune > 60 * 60_000) {
        lastPrune = Date.now();
        const removed = await pruneOld(db);
        if (removed) console.info("[webhooks] pruned old deliveries", { removed });
      }
    } catch (err: any) {
      // Before the migration has run the tables are missing: quiet until they exist.
      if (err?.code !== "42P01") console.error("[webhooks] worker tick failed", { message: err?.message ?? String(err) });
    }
  });
  const timer = setInterval(() => void tick(), intervalMs);
  const kickoff = setTimeout(() => void tick(), 15_000);
  return { stop: () => { stopped = true; clearInterval(timer); clearTimeout(kickoff); } };
}
