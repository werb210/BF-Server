// BF_SERVER_ADS_WEEKLY_EMAIL_v708 - checks every 30 minutes; sends once on Monday morning.
import type { Pool } from "pg";
import { maybeSendWeeklyAdsEmail } from "../services/adsWeeklyEmail.js";

export function startAdsWeeklyEmailWorker(_pool: Pool): { stop: () => void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await maybeSendWeeklyAdsEmail();
      if (r.sent) console.log("[ads-weekly] sent");
      // BF_SERVER_WEEKLY_SUMMARY_v721 - the business summary goes out alongside it.
      const s = await (await import("../services/weeklySummaryEmail.js")).maybeSendWeeklySummary();
      if (s.sent) console.log("[weekly-summary] sent");
    } catch (err) {
      console.error("[ads-weekly] failed:", (err as { message?: string })?.message ?? err);
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 30 * 60 * 1000);
  const kickoff = setTimeout(() => { void tick(); }, 90 * 1000);
  return { stop: () => { clearInterval(timer); clearTimeout(kickoff); } };
}
