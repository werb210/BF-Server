// BF_SERVER_GRAPH_WEBHOOKS_v1 - keep Graph mail subscriptions alive: ensure one per
// connected user and renew any nearing expiry.
import { pool } from "../db.js";
import { ensureSubscriptionsForConnectedUsers, renewDueSubscriptions } from "../modules/o365/mailSubscriptions.js";

const TICK_MS = 30 * 60 * 1000;

async function tick(): Promise<void> {
  try {
    await renewDueSubscriptions(pool);
    await ensureSubscriptionsForConnectedUsers(pool);
  } catch {
    /* best-effort */
  }
}

export function startGraphSubscriptionWorker(): NodeJS.Timeout {
  void tick();
  return setInterval(() => { void tick(); }, TICK_MS);
}
