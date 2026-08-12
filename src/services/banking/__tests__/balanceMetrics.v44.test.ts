import { expect, it } from "vitest";
import { averageDailyBalance } from "../balanceMetrics.js";

it("calculates a calendar-day weighted balance per account", () => {
  expect(averageDailyBalance([
    { accountKey: "a", date: "2026-01-01", amount: 100, balance: 100 },
    { accountKey: "a", date: "2026-01-03", amount: 100, balance: 200 },
  ], "2026-01-04")).toBe(150);
});

it("sums independently day-weighted account balances", () => {
  expect(averageDailyBalance([
    { accountKey: "cad-chequing", date: "2026-01-01", amount: 100, balance: 100 },
    { accountKey: "cad-savings", date: "2026-01-01", amount: 50, balance: 50 },
  ])).toBe(150);
});
