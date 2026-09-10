// BF_SERVER_PGI_MIRROR_VOCAB_v1
import { describe, expect, it } from "vitest";
import { BF_TO_PGI_DOC_TYPE, pgiDocTypeFor, shouldMirrorToPgi } from "../biDocMirror.js";

const ACTIVE_CATALOG = new Set([
  "loan_agreement", "profit_loss", "balance_sheet", "ar_aging", "ap_aging",
  "founder_cv", "financial_forecast",
]);

describe("BF_SERVER_PGI_MIRROR_VOCAB_v1", () => {
  it("only emits active catalog types", () => {
    for (const target of Object.values(BF_TO_PGI_DOC_TYPE)) {
      expect(ACTIVE_CATALOG.has(target)).toBe(true);
    }
  });

  it("maps BF upload categories and the signed term sheet", () => {
    expect(pgiDocTypeFor("pnl_interim")).toBe("profit_loss");
    expect(pgiDocTypeFor("balance_sheet_interim")).toBe("balance_sheet");
    expect(pgiDocTypeFor("ar")).toBe("ar_aging");
    expect(pgiDocTypeFor("ap")).toBe("ap_aging");
    expect(pgiDocTypeFor("signed_term_sheet")).toBe("loan_agreement");
  });

  it("normalizes input and rejects categories outside PGI", () => {
    expect(pgiDocTypeFor("  PNL_Interim ")).toBe("profit_loss");
    for (const value of ["six_month_bank_statements", "void_cheque", "government_id", "media_budget", "", null, undefined]) {
      expect(shouldMirrorToPgi(value)).toBe(false);
    }
  });
});
