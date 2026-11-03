// BF_SERVER_v885_OCR_LABEL_FRAGMENTS - text shaped like the DE KRUYFF balance sheet and
// P&L, where labels landed in value fields ("Receivable (A/R)", "g $1,350.00",
// "es and Licenses $319.37", "for Liabilities and Equity $402,588.95").
import { describe, expect, it } from "vitest";
import { extractOcrFields } from "../ocr.service.js";
import { isMoneyOcrField, ocrFieldDisplayLabel, parseOcrAmount } from "../ocrFieldRegistry.js";

const BALANCE_SHEET = [
  "DE KRUYFF AGRI CONTRACTORS INC.",
  "Balance Sheet As of July 31, 2026",
  "Accounts Receivable (A/R)",
  "Accounts Receivable (A/R) 230,436.87",
  "Total Accounts Receivable $230,436.87",
  "Accrued Liabilities",
  "GST/HST Payable $57,010.55",
  "Tax Payable $57,010.55",
  "Total Liabilities and Equity $402,588.95",
  "Total Liabilities $738,763.30",
  "Total Assets $402,588.95",
  "Retained Earnings $659,681.21",
].join("\n");

const PROFIT_AND_LOSS = [
  "Profit and Loss",
  "Licensing $1,350.00",
  "Subcontractors $74,480.31",
  "Taxes and Licenses $319.37",
  "Total for Other Income $39.15",
  "Total Revenue 1,119,284.32",
  "Net Income (12,500.00)",
].join("\n");

function byKey(text: string, pre: Record<string, string | number> = {}) {
  const out: Record<string, string> = {};
  for (const f of extractOcrFields(text, pre)) out[f.fieldKey] = f.value;
  return out;
}

describe("v885 OCR: a label fragment is never stored as a value", () => {
  it("balance sheet lines", () => {
    const f = byKey(BALANCE_SHEET);
    expect(f.accounts_receivable).toBe("230436.87");
    expect(f.accounts_payable).toBeUndefined(); // only "Accounts Receivable (A/R)" fuzzy-matches
    expect(f.accrued_liabilities).toBeUndefined(); // the line has no amount
    expect(f.total_liabilities).toBe("738763.3");
    expect(f.total_liabilities_and_equity).toBe("402588.95");
    expect(f.total_assets).toBe("402588.95");
    expect(f.retained_earnings).toBe("659681.21");
    for (const v of Object.values(f)) {
      expect(v).not.toMatch(/^(Receivable|Liabilities|Payable|for )/);
    }
  });

  it("P&L lines: whole-word labels only", () => {
    const f = byKey(PROFIT_AND_LOSS);
    expect(f.sin).toBeUndefined(); // "SIN" is not inside "Licensing"
    expect(f.subcontractor).toBeUndefined(); // not inside "Subcontractors"
    expect(f.subcontractors_cost).toBe("74480.31");
    expect(f.invoice_tax).toBeUndefined(); // "Tax" is not inside "Taxes and Licenses"
    expect(f.invoice_total).toBeUndefined(); // "Total for Other Income" is a label, not a total
    expect(f.total_revenue).toBe("1119284.32");
    expect(f.net_income).toBe("-12500");
  });

  it("model-extracted values: amounts kept as numbers, fragments dropped", () => {
    const f = byKey("", {
      total_expenses: "$637,652.43",
      total_other_current_liabilities: "current Liabilities :$778,266.10",
      cash_on_hand: 22545.7,
      credit_cards: "$17,507.75",
    });
    expect(f.total_expenses).toBe("637652.43");
    expect(f.total_other_current_liabilities).toBeUndefined();
    expect(f.cash_on_hand).toBe("22545.7");
    expect(f.credit_cards).toBe("17507.75");
  });

  it("parseOcrAmount", () => {
    expect(parseOcrAmount("$1,350.00")).toBe(1350);
    expect(parseOcrAmount("(12,000)")).toBe(-12000);
    expect(parseOcrAmount("$(12,000.50)")).toBe(-12000.5);
    expect(parseOcrAmount("-5,000.25")).toBe(-5000.25);
    expect(parseOcrAmount(": $778,266.10")).toBe(778266.1);
    expect(parseOcrAmount("1,234 CAD")).toBe(1234);
    expect(parseOcrAmount("g $1,350.00")).toBeNull();
    expect(parseOcrAmount("es and Licenses $319.37")).toBeNull();
    expect(parseOcrAmount("Receivable (A/R)")).toBeNull();
    expect(parseOcrAmount("")).toBeNull();
  });

  it("money fields and labels", () => {
    expect(isMoneyOcrField("accounts_payable")).toBe(true);
    expect(isMoneyOcrField("total_expenses")).toBe(true);
    expect(isMoneyOcrField("business_name")).toBe(false);
    expect(isMoneyOcrField("sin")).toBe(false);
    expect(ocrFieldDisplayLabel("total_expenses")).toBe("Total Expenses");
    expect(ocrFieldDisplayLabel("some_new_key")).toBe("Some New Key");
  });
});
