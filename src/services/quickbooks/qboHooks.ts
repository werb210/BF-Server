// BF_SERVER_v852_CALC_QBO - the one call the signing and funding code paths make. Synchronous and cheap: with
// QuickBooks not configured it returns at once (no database work, no import); otherwise it queues the file and the
// sync runs in the background. It never throws into the caller and never delays it.
import { qboConfigured } from "./qboConfig.js";

export function queueQboFeeInvoice(applicationId: string | null | undefined, reason: string): void {
  if (!applicationId || !qboConfigured()) return;
  void import("./feeInvoices.js")
    .then((m) => m.enqueueFeeInvoiceSync(String(applicationId), reason))
    .catch((err: unknown) => console.error("[quickbooks] could not queue the fee invoice", { applicationId, reason, message: (err as Error)?.message }));
}
