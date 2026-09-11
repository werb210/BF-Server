// BF_SERVER_PRESENCE_EXPLAIN_v142
// Presence is computed from several independent conditions, so "no agents are
// available" gives no clue which one fired. This turns a staff_presence row
// into the specific reason, for the diagnostics endpoint and for logs.
//
// The rules here mirror RECOMPUTE_SQL in presenceService.ts. They are stated
// once in each place on purpose - the SQL has to run set-wise in the database,
// and this has to run without one - and the test asserts they agree.

export type PresenceRow = {
  user_id: string;
  twilio_identity: string | null;
  status: string | null;
  last_heartbeat: Date | string | null;
  manual_busy?: boolean | null;
  on_call?: boolean | null;
  in_meeting?: boolean | null;
};

export type PresenceReason =
  | "available"
  | "no_heartbeat"
  | "stale_heartbeat"
  | "outside_business_hours"
  | "manual_busy"
  | "on_call"
  | "in_meeting"
  | "no_twilio_identity";

export type PresenceExplanation = {
  reachable: boolean;
  reason: PresenceReason;
  message: string;
  /** Minutes since the last heartbeat, or null when there has never been one. */
  heartbeatAgeMinutes: number | null;
  localHour: number | null;
};

export const HEARTBEAT_STALE_MINUTES = 5;
export const BUSINESS_START_HOUR = 8;
export const BUSINESS_END_HOUR = 18;
/**
 * Alberta observes DST. The original rule used Postgres 'MST', a fixed UTC-7
 * abbreviation, which silently shifted the window by an hour for most of the
 * year - 09:00-19:00 local through the summer.
 */
export const BUSINESS_TIMEZONE = "America/Edmonton";

export function localHourIn(when: Date, timeZone = BUSINESS_TIMEZONE): number {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).format(when);
  const hour = Number.parseInt(formatted, 10);
  return Number.isFinite(hour) ? hour % 24 : when.getUTCHours();
}

export function withinBusinessHours(when: Date, timeZone = BUSINESS_TIMEZONE): boolean {
  const hour = localHourIn(when, timeZone);
  return hour >= BUSINESS_START_HOUR && hour < BUSINESS_END_HOUR;
}

function ageMinutes(value: Date | string | null | undefined, now: Date): number | null {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return (now.getTime() - at.getTime()) / 60000;
}

/**
 * Order matters and matches the SQL CASE: a stale heartbeat wins over every
 * busy reason, because an offline device cannot be busy.
 */
export function explainPresence(
  row: PresenceRow,
  now: Date = new Date(),
  timeZone = BUSINESS_TIMEZONE,
): PresenceExplanation {
  const age = ageMinutes(row.last_heartbeat, now);
  const hour = localHourIn(now, timeZone);

  const base = { heartbeatAgeMinutes: age, localHour: hour };

  if (age === null) {
    return {
      ...base,
      reachable: false,
      reason: "no_heartbeat",
      message: "this user has never checked in - the app has not been opened while signed in",
    };
  }
  if (age > HEARTBEAT_STALE_MINUTES) {
    return {
      ...base,
      reachable: false,
      reason: "stale_heartbeat",
      message:
        "last check-in was " +
        Math.round(age) +
        " minutes ago; the app is closed or backgrounded, which stops the heartbeat",
    };
  }
  if (row.manual_busy) {
    return { ...base, reachable: false, reason: "manual_busy", message: "this user set themselves to busy" };
  }
  if (row.on_call) {
    return { ...base, reachable: false, reason: "on_call", message: "this user is already on a call" };
  }
  if (row.in_meeting) {
    return { ...base, reachable: false, reason: "in_meeting", message: "this user is in a meeting" };
  }
  if (!withinBusinessHours(now, timeZone)) {
    return {
      ...base,
      reachable: false,
      reason: "outside_business_hours",
      message:
        "it is " +
        hour +
        ":00 in " +
        timeZone +
        "; calls only route between " +
        BUSINESS_START_HOUR +
        ":00 and " +
        BUSINESS_END_HOUR +
        ":00, so the app being open makes no difference",
    };
  }
  if (!row.twilio_identity) {
    return {
      ...base,
      reachable: false,
      reason: "no_twilio_identity",
      message: "no Twilio identity registered - the app has not fetched a voice token",
    };
  }
  return { ...base, reachable: true, reason: "available", message: "reachable for inbound calls" };
}

/** Summarises a whole team, so the endpoint can answer "why did nobody pick up". */
export function explainTeam(rows: PresenceRow[], now: Date = new Date()) {
  const explained = rows.map((row) => ({ userId: row.user_id, ...explainPresence(row, now) }));
  const reachable = explained.filter((e) => e.reachable);
  return {
    reachableCount: reachable.length,
    total: explained.length,
    // The blocking reason when nobody is reachable, most common first.
    blockingReasons: Object.entries(
      explained
        .filter((e) => !e.reachable)
        .reduce<Record<string, number>>((acc, e) => {
          acc[e.reason] = (acc[e.reason] ?? 0) + 1;
          return acc;
        }, {}),
    )
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count })),
    staff: explained,
  };
}
