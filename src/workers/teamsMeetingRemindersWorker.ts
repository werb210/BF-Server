// BF_SERVER_TEAMS_ATTENDEE_REMINDERS_v1 - every 5 minutes, one instance per tick (src/services/teams/meetingReminders.ts).
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { defaultMeetingReminderDeps, sendDueMeetingReminders } from "../services/teams/meetingReminders.js";

const TICK_MS = 5 * 60 * 1000;

export function startTeamsMeetingRemindersWorker(pool: Pool): { stop: () => void } {
  const tick = claimedTick("teams_meeting_reminders", async () => {
    try {
      const r = await sendDueMeetingReminders(pool as any, defaultMeetingReminderDeps(pool));
      if (r.sent || r.errors || r.skipped) console.log(JSON.stringify({ event: "teams_meeting_reminders", ...r }));
    } catch (e) {
      console.error("[teams-reminders] tick failed", e instanceof Error ? e.message : e);
    }
  });
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick();
  return { stop: () => clearInterval(timer) };
}
