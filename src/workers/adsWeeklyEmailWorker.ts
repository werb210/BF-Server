// BF_SERVER_ADS_WEEKLY_EMAIL_v708 - checks every 30 minutes; sends once on Monday morning.
import type { Pool } from "pg";
import { maybeSendWeeklyAdsEmail } from "../services/adsWeeklyEmail.js";
import { claimedTick } from "./claim.js"; // BF_SERVER_v789_WORKER_CLAIM

// BF_SERVER_WEEKLY_EMAILS_PAUSED_v1 (2026-11-22) - Todd: turn off the BF weekly reporting emails for now (the Google
// Ads weekly and the weekly business summary). Paused unless BF_WEEKLY_EMAILS=on. Keystone's weekly email runs on
// the Keystone server and is not affected.
export function weeklyEmailsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.BF_WEEKLY_EMAILS ?? "").trim().toLowerCase() === "on";
}

export function startAdsWeeklyEmailWorker(_pool: Pool): { stop: () => void } {
  let running = false;
  const tickUnclaimed = async () => {
    if (running) return;
    if (!weeklyEmailsOn()) return;
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
  const tick = claimedTick("ads_weekly_email", tickUnclaimed); // BF_SERVER_v789_WORKER_CLAIM - one instance per tick
  const timer = setInterval(() => { void tick(); }, 30 * 60 * 1000);
  const kickoff = setTimeout(() => { void tick(); }, 90 * 1000);
  return { stop: () => { clearInterval(timer); clearTimeout(kickoff); } };
}
