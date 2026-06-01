import { describe, it, expect } from "vitest";
import { parseLlmTransactions } from "../bankingAnalysisPipeline.js";

describe("BF_SERVER_BLOCK_v690 parseLlmTransactions", () => {
  it("parses valid transactions and drops invalid rows", () => {
    const raw = JSON.stringify({
      transactions: [
        { date: "2025-04-03", description: "Deposit ACME", amount: 1200.5, balance: 5000 },
        { date: "2025-04-05", description: "Cheque #102", amount: "-2,300.00", balance: "2,700.00" },
        { date: "not-a-date", description: "garbage", amount: 5 },
        { date: "2025-04-09", description: "no amount" },
      ],
    });
    const out = parseLlmTransactions(raw);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ date: "2025-04-03", amount: 1200.5, balance: 5000 });
    expect(out[1]).toMatchObject({ date: "2025-04-05", amount: -2300, balance: 2700 });
  });
  it("returns [] for non-JSON or missing transactions", () => {
    expect(parseLlmTransactions("not json")).toEqual([]);
    expect(parseLlmTransactions(JSON.stringify({ foo: 1 }))).toEqual([]);
  });
});
