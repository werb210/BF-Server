// BF_SERVER_TEAM_PHASE_C_v671 - sends Team "Remind me" reminders when they come due (every minute).
import { runDueReminders } from "../services/team/teamPhaseC.js";
import { claimedTick } from "./claim.js"; // BF_SERVER_v789_WORKER_CLAIM

export function startTeamReminderWorker(): { stop: () => void } {
  let busy = false;
  const tickUnclaimed = async () => {
    if (busy) return;
    busy = true;
    try { await runDueReminders(); }
    catch (err: any) { console.warn("[team-reminders] run failed", { message: err?.message }); }
    finally { busy = false; }
  };
  const tick = claimedTick("team_reminders", tickUnclaimed); // BF_SERVER_v789_WORKER_CLAIM - one instance per tick
  const timer = setInterval(() => void tick(), 60_000);
  return { stop: () => clearInterval(timer) };
}
