// BF_SERVER_TX_INSIGHTS_v51
import { describe, expect, it } from "vitest";
import { aggregateVendors, detectUnusualTransactions, normalizeVendor } from "../transactionInsights.js";

const routineDeposits = Array.from({ length: 20 }, (_, index) => ({
  date: `2026-03-${String((index % 27) + 1).padStart(2, "0")}`,
  description: "Direct Deposit, STRIPE MSP/DIV",
  amount: 900 + (index % 7) * 25,
}));

describe("detectUnusualTransactions", () => {
  it("flags statistically unusual deposits and withdrawals", () => {
    const depositFlags = detectUnusualTransactions([
      ...routineDeposits,
      { date: "2026-03-15", description: "Incoming Wire Payment, ACME", amount: 250_000 },
    ]);
    expect(depositFlags[0]).toMatchObject({ amount: 250_000, type: "large_deposit" });

    const withdrawals = Array.from({ length: 20 }, (_, index) => ({
      date: "2026-03-02",
      description: "Pre-Authorized Payment, HYDRO",
      amount: -(400 + index),
    }));
    const withdrawalFlags = detectUnusualTransactions([
      ...withdrawals,
      { date: "2026-03-20", description: "Outgoing Wire Payment, OFFSHORE LTD", amount: -180_000 },
    ]);
    expect(withdrawalFlags).toContainEqual(expect.objectContaining({ amount: -180_000, type: "large_withdrawal" }));
  });

  it("detects NSF, repeated, and round-figure transactions", () => {
    const flags = detectUnusualTransactions([
      { date: "2026-03-03", description: "Returned item - insufficient funds", amount: -48.5 },
      { date: "2026-03-04", description: "Cheque, NO.1123", amount: -9_500 },
      { date: "2026-03-04", description: "Cheque, NO.1124", amount: -9_500 },
      { date: "2026-03-05", description: "Online Transfer", amount: -25_000 },
      { date: "2026-03-06", description: "INTERAC e-Transfer Sent", amount: -120 },
    ]);
    expect(flags.filter(({ type }) => type === "repeated_amount")).toHaveLength(2);
    expect(flags).toContainEqual(expect.objectContaining({ type: "nsf" }));
    expect(flags).toContainEqual(expect.objectContaining({ type: "round_sum" }));
    expect(flags.find(({ amount }) => amount === -120)?.type).not.toBe("nsf");
  });

  it("requires enough observations before identifying an outlier", () => {
    const flags = detectUnusualTransactions([
      { date: "2026-03-01", description: "Deposit", amount: 100 },
      { date: "2026-03-02", description: "Deposit", amount: 120 },
      { date: "2026-03-03", description: "Deposit", amount: 99_999.01 },
    ]);
    expect(flags.some(({ type }) => type === "large_deposit")).toBe(false);
    expect(detectUnusualTransactions([])).toEqual([]);
  });
});

describe("vendor aggregation", () => {
  it("normalizes payees and removes reference-only descriptions", () => {
    expect(normalizeVendor("Pre-Authorized Payment, DOMINION PREM MSP/DIV")).toBe("DOMINION PREM MSP/DIV");
    expect(normalizeVendor("Cheque, NO.1123")).toBeNull();
    expect(normalizeVendor("Online Transfer, TF 0005165660003976199")).toBeNull();
    expect(normalizeVendor("US $ Transfer, USD TFR 4795-492, AT1.3396 HC")).not.toContain("1.3396");
    expect(normalizeVendor(null)).toBeNull();
  });

  it("groups and ranks outgoing payments while excluding deposits", () => {
    const vendors = aggregateVendors([
      { date: "2026-03-01", description: "Pre-Authorized Payment, DOMINION PREM MSP/DIV", amount: -600.63 },
      { date: "2026-03-02", description: "Pre-Authorized Payment, DOMINION PREM MSP/DIV", amount: -600.63 },
      { date: "2026-03-03", description: "Pre-Authorized Payment, GBL MERCH FEES BUS/ENT", amount: -30 },
      { date: "2026-03-04", description: "Direct Deposit, STRIPE MSP/DIV", amount: 5_763.98 },
    ]);
    expect(vendors[0]).toEqual({ vendor: "DOMINION PREM MSP/DIV", total: 1201.26, count: 2 });
    expect(vendors.map(({ vendor }) => vendor)).toEqual(["DOMINION PREM MSP/DIV", "GBL MERCH FEES BUS/ENT"]);
    expect(aggregateVendors([], 1)).toEqual([]);
  });
});
