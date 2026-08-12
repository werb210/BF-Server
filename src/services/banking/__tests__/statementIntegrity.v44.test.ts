import { describe, expect, it } from "vitest";
import { detectStatementCurrency, isNsfDescription, isOpeningBalance, statementBodyFingerprint } from "../statementIntegrity.js";

describe("banking statement integrity", () => {
  it("does not find NSF inside ordinary transfer text", () => {
    expect(isNsfDescription("INTERAC e-Transfer Sent")).toBe(false);
    expect(isNsfDescription("NSF item fee - insufficient funds")).toBe(true);
  });
  it("detects currencies and opening balances", () => {
    expect(detectStatementCurrency("Business US$ Account (USD)")).toBe("USD");
    expect(detectStatementCurrency("Canadian dollars CAD")).toBe("CAD");
    expect(isOpeningBalance("Opening balance")).toBe(true);
  });
  it("fingerprints transaction bodies independently of cover text", () => {
    const tx = [{ date: "2026-01-02", description: "Deposit", amount: 10, balance: 20 }];
    expect(statementBodyFingerprint("January cover", tx)).toBe(statementBodyFingerprint("February replacement cover", tx));
  });
});
