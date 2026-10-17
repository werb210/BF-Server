// BF_SERVER_v821_DIALER - per-staff "do not disturb by hours" (staff_call_hours). For a call that would ring one
// specific person (their direct line, a named reception target, or them as a member of the engagement group) while
// they are outside their hours, the caller hears "{Name} is away right now..." and can press 1 to ring them anyway
// (urgent_passthrough) or stays on the line for their voicemail.
//
// This is NOT presenceService's business-hours window, which is America/Regina on purpose (see albertaTime.ts).
// Each person picks their own IANA zone here, and local wall-clock time comes from Intl, so DST is Intl's problem.
type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayKey = typeof DAY_KEYS[number];
export type TimeRange = [string, string];
export type WeeklyHours = Record<DayKey, TimeRange[]>;

export type CallHours = {
  enabled: boolean;
  timezone: string;
  weekly: WeeklyHours;
  urgentPassthrough: boolean;
  updatedAt: string | null;
};

export const MAX_RANGES_PER_DAY = 3;
export const DEFAULT_TIMEZONE = "America/Edmonton";

export function defaultWeekly(): WeeklyHours {
  const work: TimeRange[] = [["08:00", "18:00"]];
  return { sun: [], mon: [...work], tue: [...work], wed: [...work], thu: [...work], fri: [...work], sat: [] };
}

export function defaultCallHours(): CallHours {
  return { enabled: false, timezone: DEFAULT_TIMEZONE, weekly: defaultWeekly(), urgentPassthrough: true, updatedAt: null };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutes(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Validates a PUT body. Times are HH:MM (24 h), start < end, at most 3 ranges a day, every day key present or empty. */
export function validateCallHoursInput(body: unknown):
  | { ok: true; value: Omit<CallHours, "updatedAt"> }
  | { ok: false; error: string; message: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.enabled !== "boolean") return { ok: false, error: "invalid_enabled", message: "enabled must be true or false" };
  const timezone = b.timezone === undefined ? DEFAULT_TIMEZONE : b.timezone;
  if (!isValidTimeZone(timezone)) return { ok: false, error: "invalid_timezone", message: "timezone must be an IANA time zone, e.g. America/Edmonton" };
  const urgentPassthrough = b.urgentPassthrough === undefined ? true : b.urgentPassthrough;
  if (typeof urgentPassthrough !== "boolean") return { ok: false, error: "invalid_urgent_passthrough", message: "urgentPassthrough must be true or false" };
  const rawWeekly = b.weekly;
  if (!rawWeekly || typeof rawWeekly !== "object" || Array.isArray(rawWeekly)) {
    return { ok: false, error: "invalid_weekly", message: "weekly must be an object keyed by mon..sun" };
  }
  for (const key of Object.keys(rawWeekly)) {
    if (!(DAY_KEYS as readonly string[]).includes(key)) return { ok: false, error: "invalid_weekly", message: `unknown day "${key}"` };
  }
  const weekly = {} as WeeklyHours;
  for (const day of DAY_KEYS) {
    const ranges = (rawWeekly as Record<string, unknown>)[day] ?? [];
    if (!Array.isArray(ranges)) return { ok: false, error: "invalid_weekly", message: `${day} must be a list of [start, end] ranges` };
    if (ranges.length > MAX_RANGES_PER_DAY) return { ok: false, error: "too_many_ranges", message: `${day} has more than ${MAX_RANGES_PER_DAY} ranges` };
    const out: TimeRange[] = [];
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every((t) => typeof t === "string" && HHMM.test(t))) {
        return { ok: false, error: "invalid_time", message: `${day}: each range is ["HH:MM", "HH:MM"]` };
      }
      const [start, end] = range as [string, string];
      if (minutes(start) >= minutes(end)) return { ok: false, error: "invalid_range", message: `${day}: ${start} must be before ${end}` };
      out.push([start, end]);
    }
    weekly[day] = out;
  }
  return { ok: true, value: { enabled: b.enabled, timezone, weekly, urgentPassthrough } };
}

/** Day of week and minutes after local midnight in `timeZone` (Intl handles DST). */
export function localDayAndMinutes(now: Date, timeZone: string): { day: DayKey; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = get("weekday").slice(0, 3).toLowerCase() as DayKey;
  const hour = Number(get("hour")) % 24;
  return { day, minutes: hour * 60 + Number(get("minute")) };
}

/** True when the person takes calls now: DND off, or now falls in one of today's ranges ([start, end)). */
export function isWithinCallHours(hours: Pick<CallHours, "enabled" | "timezone" | "weekly">, now: Date = new Date()): boolean {
  if (!hours.enabled) return true;
  const tz = isValidTimeZone(hours.timezone) ? hours.timezone : DEFAULT_TIMEZONE;
  const { day, minutes: m } = localDayAndMinutes(now, tz);
  const ranges = Array.isArray(hours.weekly?.[day]) ? hours.weekly[day] : [];
  return ranges.some((r) => Array.isArray(r) && m >= minutes(r[0]) && m < minutes(r[1]));
}

function normalizeWeekly(raw: unknown): WeeklyHours {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = {} as WeeklyHours;
  for (const day of DAY_KEYS) {
    const ranges = Array.isArray(src[day]) ? (src[day] as unknown[]) : [];
    out[day] = ranges
      .filter((r): r is [string, string] => Array.isArray(r) && r.length === 2 && HHMM.test(String(r[0])) && HHMM.test(String(r[1])))
      .slice(0, MAX_RANGES_PER_DAY)
      .map((r) => [String(r[0]), String(r[1])] as TimeRange);
  }
  return out;
}

export function rowToCallHours(row: any): CallHours {
  if (!row) return defaultCallHours();
  return {
    enabled: row.enabled === true,
    timezone: isValidTimeZone(row.timezone) ? row.timezone : DEFAULT_TIMEZONE,
    weekly: normalizeWeekly(typeof row.weekly === "string" ? safeJson(row.weekly) : row.weekly),
    urgentPassthrough: row.urgent_passthrough !== false,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

export const CALL_HOURS_SELECT = `SELECT user_id::text AS user_id, enabled, timezone, weekly, urgent_passthrough, updated_at FROM staff_call_hours`;

export async function loadCallHours(q: Q, userId: string): Promise<CallHours> {
  const { rows } = await q.query(`${CALL_HOURS_SELECT} WHERE user_id::text = $1 LIMIT 1`, [userId]);
  return rowToCallHours(rows[0]);
}

export async function saveCallHours(q: Q, userId: string, value: Omit<CallHours, "updatedAt">): Promise<CallHours> {
  const { rows } = await q.query(
    `INSERT INTO staff_call_hours (user_id, enabled, timezone, weekly, urgent_passthrough, updated_at)
     VALUES ($1::uuid, $2, $3, $4::jsonb, $5, now())
     ON CONFLICT (user_id) DO UPDATE
       SET enabled = EXCLUDED.enabled, timezone = EXCLUDED.timezone, weekly = EXCLUDED.weekly,
           urgent_passthrough = EXCLUDED.urgent_passthrough, updated_at = now()
     RETURNING user_id::text AS user_id, enabled, timezone, weekly, urgent_passthrough, updated_at`,
    [userId, value.enabled, value.timezone, JSON.stringify(value.weekly), value.urgentPassthrough],
  );
  return rowToCallHours(rows[0] ?? { ...value, urgent_passthrough: value.urgentPassthrough });
}

export type AwayStatus = { away: boolean; urgentPassthrough: boolean };

/**
 * Is this staff member outside their call hours right now? Any lookup failure is logged and treated as "not away"
 * - a broken setting must never stop a call from ringing.
 */
export async function awayStatus(q: Q, userId: string | null | undefined, now: Date = new Date()): Promise<AwayStatus> {
  if (!userId) return { away: false, urgentPassthrough: true };
  try {
    const hours = await loadCallHours(q, String(userId));
    return { away: !isWithinCallHours(hours, now), urgentPassthrough: hours.urgentPassthrough };
  } catch (err: any) {
    console.warn("[call_hours] lookup failed; ringing as normal", { userId, message: err?.message });
    return { away: false, urgentPassthrough: true };
  }
}

/** The Twilio client identities (of those given) whose owners are outside their call hours right now. */
export async function identitiesOutsideHours(q: Q, identities: string[], now: Date = new Date()): Promise<Set<string>> {
  const out = new Set<string>();
  if (!identities.length) return out;
  try {
    const { rows } = await q.query(
      `SELECT sp.twilio_identity, h.enabled, h.timezone, h.weekly
         FROM staff_call_hours h JOIN staff_presence sp ON sp.user_id = h.user_id
        WHERE h.enabled = true AND sp.twilio_identity = ANY($1::text[])`,
      [identities],
    );
    for (const r of rows) {
      if (!isWithinCallHours(rowToCallHours(r), now)) out.add(String(r.twilio_identity));
    }
  } catch (err: any) {
    console.warn("[call_hours] group lookup failed; ringing everyone", { message: err?.message });
  }
  return out;
}
