// BF_SERVER_v872_PAYMENTS - every 5 minutes, one instance per tick: retries recording paid links in QuickBooks
// (backoff 1m, 5m, 15m, 1h, 3h, 6h) and marks open links past their date as expired. Idle when no link was ever made.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { runPaymentsPass } from "../payments/paymentLinks.js";

const TICK_MS = 5 * 60 * 1000;

export function startPaymentLinksWorker(pool: Pool): { stop: () => void } {
  const tick = claimedTick("payment_links", async () => {
    try {
      const r = await runPaymentsPass(pool);
      if (r.quickbooks || r.expired) console.log(JSON.stringify({ event: "payment_links_pass", ...r }));
    } catch (e) {
      console.error("[payment-links-worker] tick failed", e instanceof Error ? e.message : e);
    }
  });
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  return { stop: () => clearInterval(timer) };
}
