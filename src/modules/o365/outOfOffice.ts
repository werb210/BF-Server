// BF_SERVER_v864_PORTAL_FIXES - sentinel for the v864 server fixes block.
// BF_SERVER_v864_OOO_UNTIL - out of office with an "Active until" day.
// The portal sends { status: "alwaysEnabled", activeUntil: "YYYY-MM-DD", timeZone: "<IANA>" }. Out of office starts
// now and ends at the END of that day in the user's zone (Alberta / Manitoba / B.C. on permanent time from 2026, see
// src/lib/permanentTime.ts). Microsoft 365 gets status "scheduled" with that window, so Outlook stops the automatic
// replies by itself. Boreal records the same window on staff_presence (inbound calls do not ring someone who is out
// of office; the presence recompute turns it off at the end) and shows "Out of office" as the team-chat status until
// the same moment.
import { pool } from "../../db.js";
import { computeZone, endOfLocalDayUtc, localDateIn } from "../../lib/permanentTime.js";
import { recomputePresence } from "../presence/presenceService.js";

export type OofStatus = "disabled" | "alwaysEnabled" | "scheduled";

export type OutOfOfficePlan = {
  status: OofStatus;
  /** The automaticRepliesSetting body for Microsoft Graph. */
  auto: Record<string, unknown>;
  /** Boreal's own window; both null means out of office is off. until null with from set = no end date. */
  from: Date | null;
  until: Date | null;
};

export type OutOfOfficeError = { error: string; message: string };

/** Graph wants a wall-clock dateTime with a separate zone; send UTC without the trailing Z. */
export function graphUtc(at: Date): string {
  return at.toISOString().replace(/Z$/, "");
}

export function planOutOfOffice(body: any, now: Date = new Date()): OutOfOfficePlan | OutOfOfficeError {
  const b = body ?? {};
  let status: OofStatus = ["disabled", "alwaysEnabled", "scheduled"].includes(b.status) ? b.status : "disabled";
  const auto: Record<string, unknown> = {
    externalAudience: b.externalAudience === "none" || b.externalAudience === "contactsOnly" ? b.externalAudience : "all",
    internalReplyMessage: typeof b.internalReplyMessage === "string" ? b.internalReplyMessage : "",
    externalReplyMessage: typeof b.externalReplyMessage === "string" ? b.externalReplyMessage : "",
  };
  let from: Date | null = null;
  let until: Date | null = null;

  const activeUntil = typeof b.activeUntil === "string" ? b.activeUntil.trim() : "";
  if (status === "alwaysEnabled" && activeUntil) {
    const end = endOfLocalDayUtc(activeUntil, b.timeZone);
    if (!end) return { error: "invalid_active_until", message: "Pick a valid date for Active until." };
    if (activeUntil < localDateIn(now, b.timeZone) || end.getTime() <= now.getTime()) {
      return { error: "active_until_passed", message: "That day has already ended. Pick today or a later day." };
    }
    // On now, off at the end of the chosen day: Outlook calls this "scheduled".
    status = "scheduled";
    from = new Date(now.getTime() - 60_000);
    until = end;
  } else if (status === "scheduled") {
    const start = b.start ? new Date(String(b.start)) : null;
    const end = b.end ? new Date(String(b.end)) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return { error: "invalid_schedule", message: "Pick a start and an end for the scheduled out of office." };
    }
    if (end.getTime() <= start.getTime()) return { error: "invalid_schedule", message: "The end must be after the start." };
    from = start;
    until = end;
  } else if (status === "alwaysEnabled") {
    from = new Date(now.getTime() - 60_000);
    until = null;
  }

  auto.status = status;
  if (status === "scheduled" && from && until) {
    auto.scheduledStartDateTime = { dateTime: graphUtc(from), timeZone: "UTC" };
    auto.scheduledEndDateTime = { dateTime: graphUtc(until), timeZone: "UTC" };
  }
  return { status, auto, from, until };
}

export function isPlanError(p: OutOfOfficePlan | OutOfOfficeError): p is OutOfOfficeError {
  return (p as OutOfOfficeError).error !== undefined;
}

const OOO_TEXT = "Out of office";

/** Record Boreal's own out-of-office window. Errors are logged, never thrown: Outlook is already updated. */
export async function recordBorealOutOfOffice(userId: string, plan: Pick<OutOfOfficePlan, "from" | "until">, timeZone: unknown, now: Date = new Date()): Promise<void> {
  const on = plan.from !== null;
  try {
    await pool.query(
      `INSERT INTO staff_presence (user_id, status, out_of_office_from, out_of_office_until, last_heartbeat, updated_at)
       VALUES ($1::uuid, 'offline', $2, $3, now(), now())
       ON CONFLICT (user_id) DO UPDATE SET out_of_office_from = EXCLUDED.out_of_office_from,
                                         out_of_office_until = EXCLUDED.out_of_office_until, updated_at = now()`,
      [userId, on ? plan.from : null, on ? (plan.until ?? "infinity") : null],
    );
    await recomputePresence(userId);
  } catch (err: unknown) {
    console.warn("[ooo] could not record out of office on staff_presence", { userId, message: err instanceof Error ? err.message : String(err) });
  }
  try {
    const startsNow = on && (plan.from as Date).getTime() <= now.getTime();
    if (startsNow) {
      const label = plan.until
        ? `${OOO_TEXT} until ${new Intl.DateTimeFormat("en-CA", { timeZone: computeZone(timeZone), month: "short", day: "numeric" }).format(new Date(plan.until.getTime() - 1))}`
        : OOO_TEXT;
      await pool.query(`INSERT INTO team_user_status (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
      await pool.query(
        `UPDATE team_user_status SET status_text = $2, status_emoji = NULL, status_until = $3, updated_at = now() WHERE user_id = $1`,
        [userId, label, plan.until ? plan.until.toISOString() : null],
      );
    } else if (!on) {
      // Turning out of office off clears the status it set (and leaves any other status alone).
      await pool.query(
        `UPDATE team_user_status SET status_text = NULL, status_emoji = NULL, status_until = NULL, updated_at = now()
          WHERE user_id = $1 AND status_text LIKE '${OOO_TEXT}%'`,
        [userId],
      );
    }
  } catch (err: unknown) {
    console.warn("[ooo] could not update the team status", { userId, message: err instanceof Error ? err.message : String(err) });
  }
}

/** Boreal's stored window for the portal (until null + from set = on with no end date). */
export async function readBorealOutOfOffice(userId: string): Promise<{ from: string | null; until: string | null; active: boolean }> {
  try {
    const r = await pool.query<{ f: string | null; u: string | null; active: boolean }>(
      `SELECT out_of_office_from::text AS f,
              CASE WHEN out_of_office_until = 'infinity'::timestamptz THEN NULL ELSE out_of_office_until END AS u,
              (out_of_office_until IS NOT NULL AND out_of_office_until > now()
               AND coalesce(out_of_office_from, '-infinity'::timestamptz) <= now()) AS active
         FROM staff_presence WHERE user_id = $1::uuid`,
      [userId],
    );
    const row = r.rows[0];
    if (!row) return { from: null, until: null, active: false };
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : null);
    return { from: iso(row.f), until: iso(row.u), active: !!row.active };
  } catch (err: unknown) {
    console.warn("[ooo] could not read out of office", { userId, message: err instanceof Error ? err.message : String(err) });
    return { from: null, until: null, active: false };
  }
}
