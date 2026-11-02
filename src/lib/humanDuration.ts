// BF_SERVER_v885_FRAUD_TEXT - a gap between two times in words ("12 minutes", "3 hours", "5 days", "about 7 years")
// instead of a raw count of minutes such as "3791521 minute(s)".
export function humanDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return plural(hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 60) return plural(days, "day");
  const months = Math.round(days / 30.44);
  if (months < 24) return `about ${plural(months, "month")}`;
  return `about ${plural(Math.round(days / 365.25), "year")}`;
}
