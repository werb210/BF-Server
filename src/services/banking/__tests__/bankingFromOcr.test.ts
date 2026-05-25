import { describe, expect, it } from "vitest";
import {
  extractTransactionsFromBankStatementModel,
  extractTransactionsFromTables,
} from "../bankingFromOcr";

describe("extractTransactionsFromBankStatementModel", () => {
  it("reads Accounts[].Transactions[] with DepositAmount/WithdrawalAmount", () => {
    const result = {
      documents: [{
        fields: {
          Accounts: {
            valueArray: [{
              valueObject: {
                Transactions: {
                  valueArray: [
                    { valueObject: {
                        Date: { valueDate: "2026-01-15" },
                        Description: { valueString: "PAYROLL DEPOSIT" },
                        DepositAmount: { valueNumber: 2500 },
                        Balance: { valueNumber: 5000 },
                    }},
                    { valueObject: {
                        Date: { valueDate: "2026-01-16" },
                        Description: { valueString: "RENT CHECK" },
                        WithdrawalAmount: { valueNumber: 1200 },
                        Balance: { valueNumber: 3800 },
                    }},
                  ],
                },
              },
            }],
          },
        },
      }],
    };
    const out = extractTransactionsFromBankStatementModel(result);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ date: "2026-01-15", amount: 2500, balance: 5000 });
    expect(out[1]).toMatchObject({ date: "2026-01-16", amount: -1200, balance: 3800 });
  });

  it("reads document-level Transactions[] (legacy schema)", () => {
    const result = {
      documents: [{
        fields: {
          Transactions: {
            valueArray: [
              { valueObject: {
                  Date: { valueDate: "2026-02-01" },
                  Description: { valueString: "ACH" },
                  Amount: { valueNumber: -500 },
              }},
            ],
          },
        },
      }],
    };
    const out = extractTransactionsFromBankStatementModel(result);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ date: "2026-02-01", amount: -500 });
  });
});

describe("extractTransactionsFromTables — improvements", () => {
  it("combines split debit/credit columns", () => {
    const doc = {
      pages: [{
        tables: [{
          rows: [
            [{ text: "Date" }, { text: "Description" }, { text: "Debit" }, { text: "Credit" }, { text: "Balance" }],
            [{ text: "01/15/2026" }, { text: "Payroll" }, { text: "" }, { text: "$2,500.00" }, { text: "$5,000.00" }],
            [{ text: "01/16/2026" }, { text: "Rent" }, { text: "$1,200.00" }, { text: "" }, { text: "$3,800.00" }],
          ],
        }],
      }],
    };
    const out = extractTransactionsFromTables(doc);
    expect(out).toHaveLength(2);
    expect(out[0].amount).toBe(2500);
    expect(out[1].amount).toBe(-1200);
  });

  it("matches 'Posting Date' as date header", () => {
    const doc = {
      pages: [{
        tables: [{
          rows: [
            [{ text: "Posting Date" }, { text: "Description" }, { text: "Amount" }],
            [{ text: "01/15/2026" }, { text: "Test" }, { text: "100.00" }],
          ],
        }],
      }],
    };
    const out = extractTransactionsFromTables(doc);
    expect(out).toHaveLength(1);
  });

  it("uses statement year when row date is MM/DD only", () => {
    const doc = {
      pages: [{
        tables: [{
          rows: [
            [{ text: "Date" }, { text: "Description" }, { text: "Amount" }],
            [{ text: "01/15" }, { text: "Test" }, { text: "100.00" }],
          ],
        }],
      }],
    };
    const out = extractTransactionsFromTables(doc, { statementYear: 2024 });
    expect(out[0].date).toBe("2024-01-15");
  });
});
