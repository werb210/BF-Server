// BF_SERVER_DOCUMENT_CLASSIFIER_v196
import { describe, expect, it } from "vitest";
import { classifyText, RETAG_CONFIDENCE, RETAGGABLE } from "../documentClassifier.js";
import { REQUIRED_DOCUMENT_KEYS } from "../../db/schema/requiredDocuments.js";

const BANK = `ROYAL BANK OF CANADA
Statement period: March 1 2026 to March 31 2026
Account number 12345 Transit 00219
Opening balance 14,220.18
Deposits 48,900.00  Withdrawals 41,006.22
Closing balance 22,113.96`;

const FINANCIALS = `NOTICE TO READER
Balance Sheet as at December 31 2025
Total liabilities 412,000
Shareholders equity 188,400
Income Statement for the year ended December 31 2025
Retained earnings 96,220`;

const ARTICLES = `CERTIFICATE OF INCORPORATION
Articles of Incorporation
Business Corporations Act
Registered office: 401-2781 Lancaster Road, Ottawa ON`;

describe("classification accuracy", () => {
  it("identifies a bank statement", () => {
    const verdict = classifyText(BANK, null);
    expect(verdict.type).toBe("bank_statements_6_months");
    expect(verdict.confidence).toBeGreaterThan(RETAG_CONFIDENCE);
  });

  it("identifies financial statements", () => {
    expect(classifyText(FINANCIALS, null).type).toBe("financial_statements");
  });

  it("identifies articles of incorporation", () => {
    expect(classifyText(ARTICLES, null).type).toBe("articles_of_incorporation");
  });

  it("only ever emits a canonical RequiredDocumentKey", () => {
    for (const text of [BANK, FINANCIALS, ARTICLES]) {
      const type = classifyText(text, null).type;
      if (type) expect(REQUIRED_DOCUMENT_KEYS as readonly string[]).toContain(type);
    }
  });
});

describe("refusing to guess", () => {
  it("says nothing when there is almost no text", () => {
    const verdict = classifyText("scan", null);
    expect(verdict.type).toBeNull();
    expect(verdict.shouldRetag).toBe(false);
  });

  it("says nothing for text that matches no signal", () => {
    const verdict = classifyText("Dear Todd, thanks for the call today. Speak soon. Regards, Bill.", null);
    expect(verdict.type).toBeNull();
    expect(verdict.shouldRetag).toBe(false);
  });

  it("does not retag when it agrees with the applicant", () => {
    expect(classifyText(BANK, "bank_statements_6_months").shouldRetag).toBe(false);
  });
});

describe("retag safety", () => {
  it("never retags below the confidence floor", () => {
    const weak = classifyText("deposits", "government_id");
    expect(weak.confidence).toBeLessThan(RETAG_CONFIDENCE);
    expect(weak.shouldRetag).toBe(false);
  });

  it("only retags into the agreed high-value types", () => {
    for (const key of RETAGGABLE) {
      expect(REQUIRED_DOCUMENT_KEYS as readonly string[]).toContain(key);
    }
    expect(RETAGGABLE).not.toContain("equipment_quote");
    expect(RETAGGABLE).not.toContain("purchase_order");
  });

  it("retags a bank statement filed under the wrong slot", () => {
    const verdict = classifyText(BANK, "articles_of_incorporation");
    expect(verdict.type).toBe("bank_statements_6_months");
    expect(verdict.shouldRetag).toBe(true);
  });
});
