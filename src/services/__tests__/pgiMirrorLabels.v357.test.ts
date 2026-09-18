// BF_SERVER_PGI_MIRROR_LABELS_v357
import { describe, it, expect } from "vitest";
import fs from "fs";
import { pgiDocTypeFor, shouldMirrorToPgi } from "../biDocMirror.js";

describe("PGI mirror recognises the labels documents are filed under", () => {
  it("maps the Request Items labels", () => {
    expect(pgiDocTypeFor("A/R")).toBe("ar_aging");
    expect(pgiDocTypeFor("A/P")).toBe("ap_aging");
    expect(pgiDocTypeFor("PnL – Interim financials")).toBe("profit_loss");
    expect(pgiDocTypeFor("P&L – Interim financials")).toBe("profit_loss");
    expect(pgiDocTypeFor("Balance Sheet – Interim financials")).toBe("balance_sheet");
  });
  it("still maps the original codes", () => {
    expect(pgiDocTypeFor("ap")).toBe("ap_aging");
    expect(pgiDocTypeFor("pnl_interim")).toBe("profit_loss");
  });
  it("does not mirror documents PGI does not take", () => {
    for (const v of ["6 months business banking statements", "3 years accountant prepared financials", "VOID cheque or PAD", "Other"]) {
      expect(shouldMirrorToPgi(v)).toBe(false);
    }
  });
  it("logs skipped mirrors and catches up existing documents after boot", () => {
    const svc = fs.readFileSync("src/services/biDocMirror.ts", "utf8");
    const index = fs.readFileSync("src/index.ts", "utf8");
    expect(svc).toContain('logInfo("bi_doc_mirror_skipped"');
    expect(svc).toContain("export async function backfillPgiMirrors(");
    expect(svc).toContain("WHERE a.bi_public_id IS NOT NULL");
    expect(index).toContain("m.backfillPgiMirrors(30)");
  });
});
