// BF_SERVER_v872_QUOTES - the quote maths, parsing lender offer text, input checks, expiry, sales tax on ticked fees
// (v865 helper) and the PDF.
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { amortisedPayment, computeOption, parseFrequency, parseRate, parseTermMonths, paymentCount, periodicIrr } from "../calc.js";
import { effectiveStatus, optionFromOffer, parseOptions, clientQuote, type QuoteView } from "../service.js";
import { money, rateText, renderQuotePdf, termText, winAnsi } from "../pdf.js";
import { defaultRate, feeTaxFor } from "../../brokerTools/salesTax.js";

describe("quote maths", () => {
  it("amortised loan: 100,000 at 12% over 12 monthly payments", () => {
    const m = computeOption({ amount: 100_000, term_months: 12, rate_kind: "interest_rate", rate: 12, payment_frequency: "monthly", fees: [] });
    expect(m.payment_count).toBe(12);
    expect(m.payment_amount).toBeCloseTo(8884.88, 2);
    expect(m.total_repayment).toBeCloseTo(106_618.56, 1);
    expect(m.cost_of_borrowing).toBeCloseTo(6618.56, 1);
    expect(m.estimated_apr).toBeCloseTo(12, 1);
  });

  it("factor rate with a fee taken from the funds", () => {
    const m = computeOption({ amount: 50_000, term_months: 6, rate_kind: "factor_rate", rate: 1.3, payment_frequency: "daily", fees: [{ label: "Origination", amount: 1500, deducted: true }] });
    expect(m.payment_count).toBe(126);
    expect(m.total_repayment).toBe(65_000);
    expect(m.payment_amount).toBeCloseTo(515.87, 2);
    expect(m.total_fees).toBe(1500);
    expect(m.net_proceeds).toBe(48_500);
    expect(m.cost_of_borrowing).toBe(16_500);
    expect(m.estimated_apr!).toBeGreaterThan(90); // short-term factor money is expensive, and the APR shows it
  });

  it("a payment the lender quoted wins over the calculation", () => {
    const m = computeOption({ amount: 20_000, term_months: 12, rate_kind: "interest_rate", rate: 10, payment_frequency: "weekly", payment_amount: 450, payment_overridden: true, fees: [] });
    expect(m.payment_count).toBe(52);
    expect(m.payment_amount).toBe(450);
    expect(m.total_repayment).toBe(23_400);
  });

  it("no rate or term: no payment yet; zero-rate splits evenly", () => {
    expect(computeOption({ amount: 1000, term_months: null, rate_kind: "interest_rate", rate: 5, payment_frequency: "monthly", fees: [] }).payment_amount).toBeNull();
    expect(amortisedPayment(1200, 0, 12, 12)).toBe(100);
    expect(paymentCount(3, "biweekly")).toBe(7);
    expect(periodicIrr(1000, 100, 10)).toBe(0);
  });

  it("reads lender offer text", () => {
    expect(parseRate("1.35")).toEqual({ rate_kind: "factor_rate", rate: 1.35 });
    expect(parseRate("Factor 1.4")).toEqual({ rate_kind: "factor_rate", rate: 1.4 });
    expect(parseRate("12.5%")).toEqual({ rate_kind: "interest_rate", rate: 12.5 });
    expect(parseRate("prime + 2")).toEqual({ rate_kind: "interest_rate", rate: 2 });
    expect(parseRate("")).toBeNull();
    expect(parseTermMonths("2 years")).toBe(24);
    expect(parseTermMonths("52 weeks")).toBe(12);
    expect(parseTermMonths("18")).toBe(18);
    expect(parseFrequency("Bi-weekly")).toBe("biweekly");
    expect(parseFrequency("daily ACH")).toBe("daily");
    const o = optionFromOffer({ id: "o1", lender_name: "Northern Capital", amount: "75000", rate_factor: "1.28", term: "9 months", payment_frequency: "Weekly", recommended: true });
    expect(o).toMatchObject({ offer_id: "o1", amount: 75000, rate_kind: "factor_rate", rate: 1.28, term_months: 9, payment_frequency: "weekly", recommended: true });
  });
});

describe("quote input", () => {
  it("checks every option", () => {
    expect(parseOptions([{ lender_name: "", amount: 1 }])).toMatchObject({ ok: false });
    expect(parseOptions([{ lender_name: "A", amount: 0 }])).toMatchObject({ ok: false });
    expect(parseOptions([{ lender_name: "A", amount: 10, rate_kind: "factor_rate", rate: 9 }])).toMatchObject({ ok: false });
    expect(parseOptions([{ lender_name: "A", amount: 10, fees: [{ label: "", amount: 5 }] }])).toMatchObject({ ok: false });
    expect(parseOptions(Array.from({ length: 7 }, () => ({ lender_name: "A", amount: 1 })))).toMatchObject({ ok: false });
    const ok = parseOptions([{ lender_name: "A", amount: "10000", term_months: 12, rate: 9, payment_frequency: "nonsense", fees: [{ label: "Admin", amount: "250", deducted: true }, { label: "", amount: "" }] }]);
    expect(ok.ok && ok.options[0]).toMatchObject({ amount: 10000, payment_frequency: "monthly", fees: [{ label: "Admin", amount: 250, deducted: true, taxable: false }] });
    const taxed = parseOptions([{ lender_name: "A", amount: 1000, fees: [{ label: "Broker fee", amount: 100, taxable: true }] }]);
    expect(taxed.ok && taxed.options[0]!.fees[0]).toEqual({ label: "Broker fee", amount: 100, deducted: false, taxable: true });
  });

  it("a sent quote past its expiry day reads as expired; drafts never expire", () => {
    expect(effectiveStatus("sent", "2026-10-31", "2026-11-01")).toBe("expired");
    expect(effectiveStatus("viewed", "2026-11-01", "2026-11-01")).toBe("viewed");
    expect(effectiveStatus("draft", "2026-10-01", "2026-11-01")).toBe("draft");
    expect(effectiveStatus("accepted", "2026-10-01", "2026-11-01")).toBe("accepted");
  });
});

const QUOTE: QuoteView = {
  id: "11111111-1111-1111-1111-111111111111", application_id: "app", quote_number: "Q-261101-ABCDE", status: "sent", title: "Your financing options",
  message: "Here are the two best offers we found for you.", currency: "CAD", tax_province: "ON", expires_on: "2026-11-15", pdf_document_id: null, accepted_option_id: null,
  accepted_name: null, decline_reason: null, view_count: 0, created_at: "2026-11-01T00:00:00.000Z", sent_at: "2026-11-01T00:00:00.000Z",
  first_viewed_at: null, last_viewed_at: null, accepted_at: null, declined_at: null, withdrawn_at: null,
  options: [
    { id: "a", position: 0, offer_id: "o1", lender_name: "Northern Capital", product_name: "Term loan", amount: 100000, term_months: 12, rate_kind: "interest_rate", rate: 12, payment_frequency: "monthly", payment_count: 12, payment_amount: 8884.88, payment_overridden: false, fees: [{ label: "Origination – 2%", amount: 2000, deducted: true, taxable: true }], tax_lines: [{ label: "HST 13%", amount: 260 }], total_tax: 260, total_fees: 2260, total_repayment: 106618.56, cost_of_borrowing: 8618.56, net_proceeds: 98000, estimated_apr: 15.9, recommended: true, notes: "No prepayment penalty." },
    { id: "b", position: 1, offer_id: null, lender_name: "Prairie Funding", product_name: null, amount: 80000, term_months: 6, rate_kind: "factor_rate", rate: 1.3, payment_frequency: "daily", payment_count: 126, payment_amount: 825.4, payment_overridden: false, fees: [], tax_lines: [], total_tax: 0, total_fees: 0, total_repayment: 104000, cost_of_borrowing: 24000, net_proceeds: 80000, estimated_apr: 95.1, recommended: false, notes: null },
  ],
};

describe("the quote PDF", () => {
  it("renders a real PDF with every option", async () => {
    const pdf = await renderQuotePdf(QUOTE, { businessName: "Acme Ltd." });
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toContain("Q-261101-ABCDE");
    expect(money(1234.5, "CAD")).toBe("$1,234.50");
    expect(money(10, "USD")).toBe("$10.00 USD");
    expect(rateText({ rate_kind: "factor_rate", rate: 1.3 })).toBe("Factor 1.30");
    expect(termText(0.5)).toBe("15 days");
  });

  it("the client never sees offer ids or overrides", () => {
    const c = clientQuote(QUOTE);
    expect(JSON.stringify(c)).not.toContain("offer_id");
    expect(JSON.stringify(c)).not.toContain("payment_overridden");
    expect(c.options).toHaveLength(2);
  });

  it("sales tax: only fees ticked taxable, at the province's rate; interest and factor cost are never taxed", () => {
    const base = { amount: 10_000, term_months: 12, rate_kind: "interest_rate" as const, rate: 10, payment_frequency: "monthly" as const,
      fees: [{ label: "Broker fee", amount: 500, deducted: false, taxable: true }, { label: "Lender fee", amount: 300, deducted: true, taxable: false }] };
    const none = computeOption(base);
    expect(none.tax_lines).toEqual([]);
    expect(none.total_tax).toBe(0);
    const on = computeOption(base, feeTaxFor(defaultRate("ON")));
    expect(on.tax_lines).toEqual([{ label: "HST 13%", amount: 65 }]);
    expect(on.total_fees).toBe(865);
    expect(on.payment_amount).toBe(none.payment_amount);
    expect(on.cost_of_borrowing).toBe((none.cost_of_borrowing ?? 0) + 65);
    const qc = computeOption(base, feeTaxFor(defaultRate("QC")));
    expect(qc.tax_lines.map((t) => t.label)).toEqual(["GST 5%", "QST 9.975%"]);
    expect(qc.total_tax).toBeCloseTo(74.88, 2);
    const ab = computeOption(base, feeTaxFor(defaultRate("AB")));
    expect(ab.tax_lines).toEqual([{ label: "GST 5%", amount: 25 }]);
  });

  it("PDF text is WinAnsi-safe", () => {
    expect(winAnsi("Origination \u2013 2% \u201cfee\u201d \u2192")).toBe('Origination - 2% "fee" ');
  });
});
