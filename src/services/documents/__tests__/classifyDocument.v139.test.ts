import { describe, expect, it } from "vitest";
import { CONFIDENCE_FLOOR, checkAgainstExpected, classifiableTypes, classifyDocumentText, normalizeText, scoreAll } from "../classifyDocument.js";
import { REQUIRED_DOCUMENT_KEYS } from "../../../db/schema/requiredDocuments.js";

const BANK = "Statement of Account Account number 123 Opening balance 100 Withdrawals and deposits Deposit 20 Closing balance 120";
const TAX = "Canada Revenue Agency Notice of Assessment Taxation year 2024 T2 Corporation Income Tax Return Taxable income 210400";
const INVOICE = "Invoice Number 88213 Bill To: Acme Model CAT-320 Serial 4471PX Unit price 214000 Subtotal 214000 GST 10700 Amount due 224700";
const QUOTE = "Quotation Quote Number Q-5512 Proposal for equipment Model CAT-320 Serial TBD Unit price 214000 Valid for 30 days";

describe("BF_SERVER_DOC_CLASSIFY_v139", () => {
  it("classifies common documents", () => {
    expect(classifyDocumentText(BANK).documentType).toBe("bank_statements_6_months");
    expect(classifyDocumentText(TAX).documentType).toBe("tax_returns");
    expect(classifyDocumentText(INVOICE).documentType).toBe("equipment_invoice");
    expect(classifyDocumentText(QUOTE).documentType).toBe("equipment_quote");
    expect(classifyDocumentText(BANK).confidence).toBeGreaterThan(CONFIDENCE_FLOOR);
  });

  it("uses vetoes and exposes audit details", () => {
    expect(scoreAll(TAX).some((score) => score.type === "bank_statements_6_months")).toBe(false);
    expect(classifyDocumentText(INVOICE).alternative).not.toBeNull();
    expect(classifyDocumentText(BANK).reason).toContain("matched");
  });

  it("is conservative without sufficient evidence", () => {
    for (const text of ["", "hello, see attached", "the vendor said so"]) {
      expect(classifyDocumentText(text).documentType).toBeNull();
    }
    expect(checkAgainstExpected("unreadable scan", "tax_returns").mismatch).toBe(false);
  });

  it("normalizes OCR punctuation and expected key separators", () => {
    expect(normalizeText("Driver\u2019s Licence")).toContain("driver's licence");
    expect(checkAgainstExpected(BANK, "bank statements 6 months").mismatch).toBe(false);
  });

  it("flags only confident mismatches", () => {
    expect(checkAgainstExpected(TAX, "bank_statements_6_months")).toMatchObject({ mismatch: true, detected: "tax_returns" });
    expect(checkAgainstExpected(TAX, null).mismatch).toBe(false);
  });

  it("only emits canonical types and bounded confidence", () => {
    expect(classifiableTypes().length).toBeGreaterThan(10);
    for (const type of classifiableTypes()) expect(REQUIRED_DOCUMENT_KEYS).toContain(type);
    for (const text of [BANK, TAX, INVOICE, QUOTE, ""]) expect(classifyDocumentText(text).confidence).toBeGreaterThanOrEqual(0);
    for (const text of [BANK, TAX, INVOICE, QUOTE, ""]) expect(classifyDocumentText(text).confidence).toBeLessThanOrEqual(1);
  });
});
