// BF_SERVER_FEE_MANUAL_SIGN_v775
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseManualFeeInput } from "../routes/portalFeeAgreement.js";

const now = new Date("2026-10-07T20:00:00Z");
describe("marking a fee agreement signed outside the portal", () => {
  it("needs a note saying what was agreed", () => {
    expect(parseManualFeeInput({}, now)).toEqual({ ok: false, message: "Add a short note about what was agreed." });
  });
  it("keeps a negotiated percent or fixed amount and the signed date", () => {
    const r = parseManualFeeInput({ note: "Version 3 signed by hand", feePercent: "1.5", signedOn: "2026-10-06" }, now);
    expect(r.ok && r.value.feePercent).toBe(1.5);
    expect(r.ok && r.value.feeAmount).toBe(null);
    expect(r.ok && r.value.signedAt.toISOString().slice(0, 10)).toBe("2026-10-06");
    const f = parseManualFeeInput({ note: "Flat fee", feeAmount: 25000 }, now);
    expect(f.ok && f.value.feeAmount).toBe(25000);
  });
  it("refuses impossible values", () => {
    expect(parseManualFeeInput({ note: "x", feePercent: 150 }, now).ok).toBe(false);
    expect(parseManualFeeInput({ note: "x", feeAmount: -5 }, now).ok).toBe(false);
    expect(parseManualFeeInput({ note: "x", signedOn: "2026-12-25" }, now).ok).toBe(false);
    expect(parseManualFeeInput({ note: "x", signedOn: "not a date" }, now).ok).toBe(false);
  });
  it("routes, migration and the report are wired", () => {
    const routes = readFileSync("src/routes/portalFeeAgreement.ts", "utf8");
    expect(routes).toContain('"/applications/:id/fee-agreement/mark-signed"');
    expect(routes).toContain('"/applications/:id/fee-agreement/unmark-signed"');
    expect(routes).toContain("WHERE application_id = $1 AND signed_manually = true");
    expect(readFileSync("migrations/2026_10_07_v775_fee_agreement_manual.sql", "utf8")).toContain("ADD COLUMN IF NOT EXISTS signed_manually");
    expect(readFileSync("src/services/reports/data2.ts", "utf8")).toContain("m.signed_manually, m.fee_percent, m.fee_amount");
  });
});
