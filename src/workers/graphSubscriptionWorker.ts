// BF_SERVER_GRAPH_WEBHOOKS_v1 - keep Graph mail subscriptions alive: ensure one per
// connected user and renew any nearing expiry.
import { pool } from "../db.js";
import { ensureSubscriptionsForConnectedUsers, renewDueSubscriptions } from "../modules/o365/mailSubscriptions.js";
import { claimedTick } from "./claim.js"; // BF_SERVER_v789_WORKER_CLAIM

const TICK_MS = 30 * 60 * 1000;

async function tickUnclaimed(): Promise<void> {
  try {
    await renewDueSubscriptions(pool);
    await ensureSubscriptionsForConnectedUsers(pool);
  } catch (err) {
    // best-effort; BF_SERVER_v789_WORKER_CLAIM - logged instead of a bare catch
    console.warn("[graph-subscriptions] tick failed", { message: (err as Error)?.message ?? String(err) });
  }
}
const tick = claimedTick("graph_subscriptions", tickUnclaimed); // BF_SERVER_v789_WORKER_CLAIM - one instance per tick

export function startGraphSubscriptionWorker(): NodeJS.Timeout {
  void tick();
  return setInterval(() => { void tick(); }, TICK_MS);
}
