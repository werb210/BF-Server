export interface BalancePoint { date: string; balance: number; amount?: number; accountKey: string; }

/** Day-weighted average balance. A balance applies after its transaction through the day before the next point. */
export function averageDailyBalance(points: BalancePoint[], periodEnd?: string): number | null {
  const accounts = new Map<string, BalancePoint[]>();
  for (const point of points) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date) || !Number.isFinite(point.balance)) continue;
    const list = accounts.get(point.accountKey) ?? [];
    list.push(point);
    accounts.set(point.accountKey, list);
  }
  let combinedAverage = 0;
  for (const list of accounts.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const start = Date.parse(`${list[0]!.date}T00:00:00Z`);
    const requestedEnd = periodEnd ? Date.parse(`${periodEnd}T00:00:00Z`) : NaN;
    const end = Number.isFinite(requestedEnd) && requestedEnd >= start
      ? requestedEnd
      : Date.parse(`${list[list.length - 1]!.date}T00:00:00Z`);
    const opening = list[0]!.balance - (list[0]!.amount ?? 0);
    let accountTotal = 0;
    let accountDays = 0;
    let cursor = start;
    let balance = opening;
    for (const point of list) {
      const at = Date.parse(`${point.date}T00:00:00Z`);
      const span = Math.max(0, Math.round((at - cursor) / 86_400_000));
      accountTotal += balance * span;
      accountDays += span;
      cursor = at;
      balance = point.balance;
    }
    const finalSpan = Math.max(1, Math.round((end - cursor) / 86_400_000) + 1);
    accountTotal += balance * finalSpan;
    accountDays += finalSpan;
    if (accountDays) combinedAverage += accountTotal / accountDays;
  }
  return accounts.size ? combinedAverage : null;
}
