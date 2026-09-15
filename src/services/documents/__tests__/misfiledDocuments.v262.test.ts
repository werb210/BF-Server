// BF_SERVER_MISFILED_DOCS_v262
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { misfiledSignal } from "../misfiledDocuments.js";
import { classifyText } from "../../documentClassifier.js";

const base = { category_before_retag: null, detected_confidence: 0.82 };

describe("filed as X, looks like Y", () => {
  it("flags a tax return filed under accountant prepared financials", () => {
    const s = misfiledSignal({ ...base, document_type: "3 years accountant prepared financials", category: "3 years accountant prepared financials", detected_type: "tax_returns" });
    expect(s).toMatchObject({ looksMisfiled: true, detectedLabel: "tax returns", detectedConfidence: 0.82 });
  });
  it("does not flag a bank statement filed under its human label", () => {
    const s = misfiledSignal({ ...base, document_type: "6 months business banking statements", category: "6 months business banking statements", detected_type: "bank_statements_6_months" });
    expect(s.looksMisfiled).toBe(false);
  });
  it("stays quiet when unsure or when OCR found nothing", () => {
    expect(misfiledSignal({ ...base, detected_confidence: 0.4, document_type: "A/P", category: "A/P", detected_type: "financial_statements" }).looksMisfiled).toBe(false);
    expect(misfiledSignal({ ...base, document_type: "A/P", category: "A/P", detected_type: null }).looksMisfiled).toBe(false);
  });
  it("reports a genuine automatic move", () => {
    const s = misfiledSignal({ document_type: "3 years accountant prepared financials", category: "tax_returns", category_before_retag: "3 years accountant prepared financials", detected_type: "tax_returns", detected_confidence: 0.9 });
    expect(s.autoMovedFrom).toBe("3 years accountant prepared financials");
  });
});

describe("auto-retag no longer rewrites correctly filed documents", () => {
  const BANK = "ROYAL BANK OF CANADA\nStatement period: March 1 2026 to March 31 2026\nAccount number 12345 Transit 00219\nOpening balance 14,220.18\nDeposits 48,900.00  Withdrawals 41,006.22\nClosing balance 22,113.96";
  it("a bank statement under its portal label is not retagged", () => {
    const verdict = classifyText(BANK, "6 months business banking statements");
    expect(verdict.type).toBe("bank_statements_6_months");
    expect(verdict.shouldRetag).toBe(false);
  });
  it("a bank statement filed somewhere else still is", () => {
    expect(classifyText(BANK, "3 years accountant prepared financials").shouldRetag).toBe(true);
  });
});

describe("wiring", () => {
  it("the portal application payload carries the signal and the repair migration is idempotent", () => {
    const portal = fs.readFileSync("src/routes/portal.ts", "utf8");
    expect(portal).toContain("misfiledSignal(classificationById.get(");
    const sql = fs.readFileSync("migrations/2026_09_16_v262_undo_label_retags.sql", "utf8");
    expect(sql).toContain("SET category = category_before_retag");
    expect(sql).toContain("category_before_retag IS NOT NULL");
  });
});
