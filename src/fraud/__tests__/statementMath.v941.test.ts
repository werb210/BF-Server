// BF_SERVER_v941_STATEMENT_MATH_FIXES - reading problems are not reported as tampering.
import { describe, expect, it } from "vitest";
import { checkStatementArithmetic } from "../checks/statementMath.js";

const codes = (r: any) => (r.reasons ?? []).map((x: any) => `${x.code}:${x.severity}`);

describe("statement math reading problems", () => {
  it("an opening balance read as $0.00 that the running balances contradict is ignored", () => {
    const r = checkStatementArithmetic([
      { date: "2024-10-01", description: "Opening balance", balance: 0 },
      { date: "2024-10-02", description: "Deposit", amount: 500, balance: 2290.03 },
      { date: "2024-10-03", description: "Cheque", amount: -100, balance: 2190.03 },
      { date: "2024-10-04", description: "Fee", amount: -10, balance: 2180.03 },
      { date: "2024-10-31", description: "Closing balance", balance: 2180.03 },
    ]);
    expect(codes(r)).not.toContain("totals_mismatch:red");
    expect(codes(r)).toContain("math_ok:info");
  });

  it("an overdrawn balance printed without its minus sign is not an edit", () => {
    const r = checkStatementArithmetic([
      { date: "2025-01-15", description: "Deposit", amount: 100, balance: -3042.03 },
      { date: "2025-01-16", description: "Deposit", amount: 100, balance: 2942.03 },
      { date: "2025-01-17", description: "Deposit", amount: 50, balance: -2892.03 },
      { date: "2025-01-18", description: "Deposit", amount: 50, balance: -2842.03 },
    ]);
    expect(codes(r).some((c: string) => c.startsWith("balance_breaks"))).toBe(false);
  });

  it("a closing figure bigger than all the transactions is reported as unreadable, not as fraud", () => {
    const r = checkStatementArithmetic([
      { date: "2025-04-01", description: "Opening balance", balance: 100 },
      { date: "2025-04-02", description: "Deposit", amount: 50, balance: 150 },
      { date: "2025-04-03", description: "Cheque", amount: -20, balance: 130 },
      { date: "2025-04-04", description: "Fee", amount: -5, balance: 125 },
      { date: "2025-04-30", description: "Closing balance", balance: 160000 },
      { date: "2025-04-30", description: "Closing balance INTEREST PAID YEAR TO DATE", amount: -4086 },
    ]);
    expect(codes(r)).toContain("totals_unreadable:info");
    expect(codes(r)).not.toContain("totals_mismatch:red");
  });

  it("a real edit still breaks the chain", () => {
    const r = checkStatementArithmetic([
      { date: "2025-04-01", description: "Opening balance", balance: 1000 },
      { date: "2025-04-02", description: "Deposit", amount: 5000, balance: 1500 },
      { date: "2025-04-03", description: "Cheque", amount: -200, balance: 1300 },
      { date: "2025-04-04", description: "Cheque", amount: -100, balance: 1200 },
      { date: "2025-04-30", description: "Closing balance", balance: 1200 },
    ]);
    expect(codes(r).some((c: string) => c.startsWith("balance_breaks") || c === "totals_mismatch:red")).toBe(true);
  });
});
