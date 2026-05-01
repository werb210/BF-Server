// BF_SERVER_BLOCK_1_30_DOC_INTEL_AND_BANKING
import { describe, it, expect } from "vitest";
import { extractTransactionsFromTables } from "../bankingFromOcr.js";

describe("BF_SERVER_BLOCK_1_30_DOC_INTEL_AND_BANKING — table parsing", () => {
  it("parses a simple Date/Description/Amount/Balance table from layout output", () => {
    const doc = { pages: [{ page_number: 1, tables: [{ rows: [[{ text: "Date" },{ text: "Description" },{ text: "Amount" },{ text: "Balance" }],[{ text: "01/02/2024" },{ text: "ACH Deposit" },{ text: "1,234.56" },{ text: "5,000.00" }],[{ text: "01/03/2024" },{ text: "Wire Transfer to ABC" },{ text: "(2,000.00)" },{ text: "3,000.00" }],], }], }],};
    const tx = extractTransactionsFromTables(doc as any);
    expect(tx.length).toBe(2);
    expect(tx[0].date).toBe("2024-01-02");
    expect(tx[0].amount).toBe(1234.56);
    expect(tx[1].amount).toBe(-2000);
  });
});
