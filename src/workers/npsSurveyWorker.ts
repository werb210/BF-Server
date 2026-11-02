// BF_SERVER_v869_SETTINGS_PACK_NPS - queues a survey for each newly funded deal and sends the ones now due. Every 15 minutes,
// one instance per tick; only while an Admin has it switched on (Settings > Client survey). Boreal has no plans.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { npsSettings, queueFundedDeals, sendDueSurveys, type SendDeps } from "../surveys/nps.js";
import { defaultReminderDeps } from "../booking/bookingPages.js";

const TICK_MS = 15 * 60 * 1000;

export async function runNpsTick(pool: Pool, deps: SendDeps = defaultReminderDeps()): Promise<{ queued: number; sent: number; skipped: number; failed: number } | null> {
  const s = await npsSettings(pool as any);
  if (!s.enabled) return null;
  const queued = await queueFundedDeals(pool as any, s);
  return { queued, ...(await sendDueSurveys(pool as any, s, deps)) };
}

export function startNpsSurveyWorker(pool: Pool): { stop: () => void } {
  const tick = claimedTick("nps_surveys", async () => {
    try {
      const r = await runNpsTick(pool);
      if (r && (r.queued || r.sent || r.failed)) console.log(JSON.stringify({ event: "nps_surveys", ...r }));
    } catch (e) {
      console.error("[nps-worker] tick failed", e instanceof Error ? e.message : e);
    }
  });
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick();
  return { stop: () => clearInterval(timer) };
}
