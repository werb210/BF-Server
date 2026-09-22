// BF_SERVER_AD_CONVERSION_WORKER_v1
// The offline-conversion uploaders existed but had exactly one caller: a manual
// POST route with no UI behind it. So nothing was ever uploaded and Google Ads
// reported zero conversions against real applications. This runs both uploaders
// on a timer. Both are env-gated and return {configured:false} when credentials
// are absent, so this is inert until GOOGLE_ADS_* is set.
//
// BF_SERVER_ADS_WORKER_HEARTBEAT_v407 - the tick used to log only when an upload
// actually moved something, so an empty log stream meant either "nothing pending"
// or "worker not running" and there was no way to tell which. Every tick now
// emits exactly one line carrying the result of all five stages.
import type { Pool } from "pg";
import { resolvePendingAdAttributions } from "../services/googleAdsAttribution.js";
import { syncCustomerMatch } from "../services/googleAdsEnhanced.js"; // BF_SERVER_ADS_ENHANCED_v403
import { uploadFundedConversions, uploadSubmitConversions } from "../services/googleAdsConversions.js";
import { retractClosedSubmitConversions, uploadQualifiedConversions } from "../services/googleAdsLeadSignals.js";

const TICK_MS = 60 * 60_000;

export function startAdConversionWorker(_pool: Pool): { stop: () => void } {
  let stopped = false, running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = Date.now();
    try {
      const submit = await uploadSubmitConversions();
      const qualified = await uploadQualifiedConversions();
      const retracted = await retractClosedSubmitConversions();
      const attribution = await resolvePendingAdAttributions();
      const customerMatch = await syncCustomerMatch(); // weekly; no-op unless GOOGLE_ADS_CUSTOMER_MATCH_ENABLED=true
      const funded = await uploadFundedConversions();
      console.log("[ads_conversion] tick", JSON.stringify({
        ms: Date.now() - startedAt,
        submit,
        qualified,
        retracted,
        funded,
        attribution,
        customerMatch,
      }));
    } catch (e) {
      console.warn("[ads_conversion] tick failed", e instanceof Error ? e.message : String(e));
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
