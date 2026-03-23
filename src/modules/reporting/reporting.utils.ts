export type GroupBy = "day" | "week" | "month";

function startOfWeek(date: Date): Date {
  const value = new Date(date);
  const day = value.getUTCDay();
  const diff = (day + 6) % 7;
  value.setUTCDate(value.getUTCDate() - diff);
  value.setUTCHours(0, 0, 0, 0);
  return value;
}

function startOfMonth(date: Date): Date {
  const value = new Date(date);
  value.setUTCDate(1);
  value.setUTCHours(0, 0, 0, 0);
  return value;
}

export function fetchPeriodKey(date: Date, groupBy: GroupBy): string {
  const normalized = new Date(date);
  normalized.setUTCHours(0, 0, 0, 0);
  if (groupBy === "week") {
    return startOfWeek(normalized).toISOString().slice(0, 10);
  }
  if (groupBy === "month") {
    return startOfMonth(normalized).toISOString().slice(0, 10);
  }
  return normalized.toISOString().slice(0, 10);
}

export function formatPeriod(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    return value.slice(0, 10);
  }
  if (value && typeof value === "object" && "toISOString" in value) {
    return (value as { toISOString: () => string }).toISOString().slice(0, 10);
  }
  return new Date(String(value)).toISOString().slice(0, 10);
}
