// BF_SERVER_AD_CONVERSION_WORKER_v1
// The offline-conversion uploaders existed but had exactly one caller: a manual
// POST route with no UI behind it. So nothing was ever uploaded and Google Ads
// reported zero conversions against real applications. This runs both uploaders
// on a timer. Both are env-gated and return {configured:false} when credentials
// are absent, so this is inert until GOOGLE_ADS_* is set.
import type { Pool } from "pg";
import { uploadFundedConversions, uploadSubmitConversions } from "../services/googleAdsConversions.js";

const TICK_MS = 60 * 60_000;

export function startAdConversionWorker(_pool: Pool): { stop: () => void } {
  let stopped = false, running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const submit = await uploadSubmitConversions();
      if (submit.configured && (submit.uploaded || submit.failed)) {
        console.log("[ads_conversion] submit", JSON.stringify(submit));
      }
      const funded = await uploadFundedConversions();
      if (funded.configured && (funded.uploaded || funded.failed)) {
        console.log("[ads_conversion] funded", JSON.stringify(funded));
      }
    } catch (e) {
      console.warn("[ads_conversion] tick failed", e instanceof Error ? e.message : String(e));
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
