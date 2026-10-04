import { ALBERTA_TZ } from "../../lib/albertaTime.js"; // BF_SERVER_ALBERTA_TIME_v743 - Alberta is UTC-6 all year
// BF_SERVER_BLOCK_v616 - condition evaluation. Pure: no SQL, easy to test.
export type Condition = { field: string; op: string; value?: unknown };

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);

export function evaluate(c: Condition, ctx: Record<string, unknown>): boolean {
  const actual = ctx[c.field];
  const list = Array.isArray(c.value) ? c.value.map(norm) : [norm(c.value)];
  switch (c.op) {
    case "eq": return Array.isArray(actual) ? actual.map(norm).includes(norm(c.value)) : norm(actual) === norm(c.value);
    case "neq": return Array.isArray(actual) ? !actual.map(norm).includes(norm(c.value)) : norm(actual) !== norm(c.value);
    case "in": return Array.isArray(actual) ? actual.map(norm).some((a) => list.includes(a)) : list.includes(norm(actual));
    case "not_in": return Array.isArray(actual) ? !actual.map(norm).some((a) => list.includes(a)) : !list.includes(norm(actual));
    case "gt": return Number(actual) > Number(c.value);
    case "gte": return Number(actual) >= Number(c.value);
    case "lt": return Number(actual) < Number(c.value);
    case "lte": return Number(actual) <= Number(c.value);
    case "contains": return String(actual ?? "").toLowerCase().includes(String(c.value ?? "").toLowerCase());
    case "is_set": return actual !== null && actual !== undefined && actual !== "" && !(Array.isArray(actual) && actual.length === 0);
    case "is_not_set": return !evaluate({ field: c.field, op: "is_set" }, ctx);
    default: return false; // unknown operator never matches
  }
}

/** Array form: every condition must hold. Legacy object form ({ toStage: "Offer" }): equality. */
export function conditionsMatch(conds: unknown, ctx: Record<string, unknown>): boolean {
  if (Array.isArray(conds)) return conds.every((c) => c && typeof c === "object" && evaluate(c as Condition, ctx));
  if (conds && typeof conds === "object") {
    return Object.entries(conds as Record<string, unknown>).every(([k, v]) => {
      const legacy = k === "toStage" ? "to_stage" : k === "fromStage" ? "from_stage" : k;
      return norm(ctx[legacy]) === norm(v);
    });
  }
  return true;
}

export function renderTokens(text: unknown, ctx: Record<string, unknown>): string {
  return String(text ?? "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) => {
    const v = ctx[k];
    return v === null || v === undefined ? "" : String(v);
  });
}

/** 09:00-20:00 in the given zone; outside it, the next 09:00. */
export function nextAllowedSendTime(now: Date, tz = ALBERTA_TZ, startHour = 9, endHour = 20): Date | null {
  const hour = Number(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now));
  if (hour >= startHour && hour < endHour) return null;
  const hoursUntil = hour >= endHour ? 24 - hour + startHour : startHour - hour;
  const t = new Date(now.getTime() + hoursUntil * 3600_000);
  t.setUTCMinutes(0, 0, 0);
  return t;
}
