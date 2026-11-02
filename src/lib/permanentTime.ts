// BF_SERVER_v864_OOO_UNTIL - time-zone helpers for a user's own zone (the browser sends its IANA name).
// Alberta, Manitoba and most of British Columbia stopped changing their clocks in 2026: Alberta stays on UTC-6,
// Manitoba on UTC-5 and B.C. on UTC-7 all year. Servers, browsers and phones with older time-zone data still move
// America/Edmonton, America/Winnipeg and America/Vancouver back an hour on 2026-11-01, so each is computed as a zone
// with the same offset all year (same rule as KS-server src/lib/brokerageTime.ts; Alberta's is src/lib/albertaTime.ts).
// Etc/GMT+N is UTC-N (the IANA sign is inverted).
import { ALBERTA_TZ } from "./albertaTime.js";

export const PERMANENT_ZONES: Readonly<Record<string, string>> = {
  "America/Edmonton": ALBERTA_TZ, // UTC-6 all year
  "America/Winnipeg": "Etc/GMT+5", // UTC-5 all year
  "America/Vancouver": "Etc/GMT+7", // UTC-7 all year
};

export function isValidTimeZone(raw: unknown): boolean {
  const tz = String(raw ?? "").trim();
  if (!tz || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone to compute with: the permanent-time provinces as fixed offsets, anything invalid as Alberta. */
export function computeZone(raw: unknown): string {
  const tz = String(raw ?? "").trim();
  if (PERMANENT_ZONES[tz]) return PERMANENT_ZONES[tz];
  return isValidTimeZone(tz) ? tz : ALBERTA_TZ;
}

/** Offset of a zone from UTC at a moment, in minutes (east positive): Regina gives -360. */
export function zoneOffsetMinutes(at: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** The UTC instant of local midnight at the start of y-m-d in a zone. */
export function zonedMidnightUtc(y: number, m: number, d: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  let at = guess - zoneOffsetMinutes(new Date(guess), tz) * 60000;
  // A second pass settles a day on which the offset changes.
  at = guess - zoneOffsetMinutes(new Date(at), tz) * 60000;
  return new Date(at);
}

/** "YYYY-MM-DD" -> its parts, or null when it is not a real calendar date. */
export function parseIsoDate(value: unknown): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const y = Number(match[1]); const m = Number(match[2]); const d = Number(match[3]);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** The end of a calendar day in a zone: the first instant of the next local day. */
export function endOfLocalDayUtc(date: string, rawZone: unknown): Date | null {
  const p = parseIsoDate(date);
  if (!p) return null;
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return zonedMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), computeZone(rawZone));
}

/** Today's date (YYYY-MM-DD) in a zone. */
export function localDateIn(at: Date, rawZone: unknown): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: computeZone(rawZone), year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
