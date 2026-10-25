// BF_SERVER_v852_CALC_QBO - the QuickBooks fee-invoice outbox. Every two minutes (one instance at a time, via
// claimedTick): queue newly signed media fee agreements and newly funded files, then sync what is due with backoff
// (src/services/quickbooks/feeInvoices.ts). Does nothing while QuickBooks is not configured or not connected.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { runFeeInvoiceTick } from "../services/quickbooks/feeInvoices.js";
import type { Q } from "../services/quickbooks/qboClient.js";

const TICK_MS = 120_000;

export function startQboFeeInvoiceWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;
  const db = pool as unknown as Q;
  const tickUnclaimed = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const out = await runFeeInvoiceTick({ db });
      if (out.queued || out.synced || out.failed) console.info({ event: "qbo_fee_invoice_tick", ...out });
    } catch (err) {
      console.error("[qbo-worker] tick failed:", (err as Error)?.message ?? err);
    } finally {
      running = false;
    }
  };
  const tick = claimedTick("qbo_fee_invoices", tickUnclaimed);
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  setTimeout(() => { void tick(); }, 40_000);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
