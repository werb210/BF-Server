// BF_SERVER_v869_SETTINGS_PACK_BOOKING - booking reminders 24 hours and 1 hour before (src/booking/bookingPages.ts). Every
// 5 minutes, one instance per tick; each booking is claimed before it is sent, so nobody gets two.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { defaultReminderDeps, sendDueReminders } from "../booking/bookingPages.js";

const TICK_MS = 5 * 60 * 1000;

export function startBookingRemindersWorker(pool: Pool): { stop: () => void } {
  const tick = claimedTick("booking_reminders", async () => {
    try {
      const r = await sendDueReminders(pool as any, defaultReminderDeps());
      if (r.email || r.sms || r.errors) console.log(JSON.stringify({ event: "booking_reminders", ...r }));
    } catch (e) {
      console.error("[booking-reminders] tick failed", e instanceof Error ? e.message : e);
    }
  });
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick();
  return { stop: () => clearInterval(timer) };
}
