// BF_SERVER_BLOCK_v466_RANGE_AMOUNTS + BF_SERVER_BLOCK_v466_SIGNATURE_NEEDED
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { amountOrRange } from "../signnow/sendApplicationForSignature.js";

describe("v466 range answers print as written on the signing form", () => {
  it("a Step 1 range keeps both ends with a dash", () => {
    expect(amountOrRange("$250,000 to $500,000")).toBe("$250,000 - $500,000");
    expect(amountOrRange("$100,001 to $250,000")).toBe("$100,001 - $250,000");
    expect(amountOrRange("250,000 - 500,000")).toBe("250,000 - 500,000");
  });

  it("worded answers stay as text", () => {
    expect(amountOrRange("Over $500,000")).toBe("Over $500,000");
    expect(amountOrRange("No Account Receivables")).toBe("No Account Receivables");
  });

  it("a plain amount is still a number", () => {
    expect(amountOrRange("$75,000")).toBe(75000);
    expect(amountOrRange(120000)).toBe(120000);
    expect(amountOrRange("")).toBeNull();
    expect(amountOrRange(null)).toBeNull();
  });

  it("the form uses it for all three range fields", () => {
    const src = fs.readFileSync("src/signnow/sendApplicationForSignature.ts", "utf8");
    expect(src).toContain("accountsReceivable: amountOrRange(kyc.accountsReceivable) ?? amountOrRange(kyc.arBalance)");
    expect(src).toContain("fixedAssets: amountOrRange(kyc.fixedAssets)");
    expect(src).toContain("availableCollateral: amountOrRange(kyc.availableCollateral)");
    const pdf = fs.readFileSync("src/signnow/pdfBuilder.ts", "utf8");
    expect(pdf).toContain("value: moneyOrRange(fu.accountsReceivable)");
  });

  it("the client's application list says which one needs a signature", () => {
    const src = fs.readFileSync("src/routes/client/v1Applications.ts", "utf8");
    expect(src).toContain(") AS signature_needed");
  });
});
