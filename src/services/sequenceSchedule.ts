// BF_SERVER_SEQ_BUSINESS_HOURS_v1 - all deadlines are weekdays inside the
// sequence's configured send window in America/Edmonton.
const ZONE = "America/Edmonton";

function localParts(at: Date): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { weekday: value("weekday"), hour: Number(value("hour")) };
}

/** Return `at`, or the earliest later minute that is a weekday in [start, end). */
export function nextSendableAt(at: Date, quietStart = 9, quietEnd = 21): Date {
  const start = Math.max(0, Math.min(23, Math.trunc(quietStart)));
  const end = Math.max(start + 1, Math.min(24, Math.trunc(quietEnd)));
  let candidate = new Date(at);
  for (let checked = 0; checked <= 8 * 24 * 60; checked++) {
    const local = localParts(candidate);
    if (local.weekday !== "Sat" && local.weekday !== "Sun" && local.hour >= start && local.hour < end) return candidate;
    candidate = new Date(candidate.getTime() + (60_000 - candidate.getTime() % 60_000));
  }
  throw new Error("Unable to find a sendable sequence time");
}

export function scheduleAfter(minutes: number, quietStart: number, quietEnd: number, now = new Date()): Date {
  return nextSendableAt(new Date(now.getTime() + Math.max(0, minutes) * 60_000), quietStart, quietEnd);
}
