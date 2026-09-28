// BF_SERVER_DOC_SHARING_v635
import { describe, it, expect } from "vitest";
import { canonicalDocKey, isPersonalDoc, businessKey } from "../services/documentKinds.js";

describe("same-meaning document names", () => {
  it("treats every spelling of government ID as one document", () => {
    for (const s of ["2 pieces of Government Issued ID", "Government ID", "owner_photo_id", "Photo ID", "Driver's licence", "passport"]) {
      expect(canonicalDocKey(s)).toBe("government_id");
    }
  });
  it("recognises the common business documents", () => {
    expect(canonicalDocKey("6 months business banking statements")).toBe("bank_statements");
    expect(canonicalDocKey("bank_statements")).toBe("bank_statements");
    expect(canonicalDocKey("VOID cheque or PAD")).toBe("void_cheque");
    expect(canonicalDocKey("PnL – Interim financials")).toBe("interim_pnl");
    expect(canonicalDocKey("Balance Sheet – Interim financials")).toBe("balance_sheet");
    expect(canonicalDocKey("3 years accountant prepared financials")).toBe("accountant_financials");
    expect(canonicalDocKey("A/R")).toBe("accounts_receivable");
    expect(canonicalDocKey("A/P")).toBe("accounts_payable");
    expect(canonicalDocKey("2 years personal tax returns (T1 generals)")).toBe("personal_tax_returns");
  });
  it("does not over-match", () => {
    expect(canonicalDocKey("Business plan / projections")).toBe("businessplanprojections");
    expect(canonicalDocKey("Lease agreement (if applicable)")).toBe("leaseagreementifapplicable");
  });
  it("knows personal from business", () => {
    expect(isPersonalDoc("Government ID")).toBe(true);
    expect(isPersonalDoc("2 years personal tax returns (T1 generals)")).toBe(true);
    expect(isPersonalDoc("6 months business banking statements")).toBe(false);
    expect(businessKey("Test - Todd's Gym")).toBe(businessKey("TEST TODDS GYM"));
    expect(businessKey("Untitled Application")).toBe("");
  });
});
