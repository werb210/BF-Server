// BF_SERVER_v906_APPLICATION_FILE - pipeline search, banking insights, OCR mime type, credit summary steps, SBA only on
// US / SBA files, the fraud score floor, and the offer reader.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { pipelineSearchClause, phoneDigits } from "../services/pipeline/pipelineSearch.js";
import { buildBankingInsights, counterparty, looksLikeLenderPayment } from "../services/banking/bankingInsights.js";
import { mimeFromFileName, resolveMimeType, sniffMimeType } from "../modules/ocr/mimeType.js";
import { stepView } from "../services/credit/steps.js";
import { isCanadianMetadata, sbaFromApplication } from "../signnow/sba/sbaTrigger.js";
import { bankStatementIds, computeScore, TAMPER_FLOOR, type StoredResult } from "../fraud/score.js";
import { normalizeOffer, readOfferDocument } from "../brokerTools/offerReader.js";
import { kindOf } from "../services/credit/docKinds.js";

describe("pipeline search (v906)", () => {
  it("is skipped for a blank query", () => {
    const values: unknown[] = ["BF"];
    expect(pipelineSearchClause("   ", values)).toBeNull();
    expect(values).toEqual(["BF"]);
  });
  it("searches names, contacts, phone digits and the application id with escaped wildcards", () => {
    const values: unknown[] = ["BF"];
    const sql = pipelineSearchClause("50%_Acme", values)!;
    expect(values[1]).toBe("%50\\%\\_Acme%");
    expect(values[2]).toBeNull(); // fewer than 4 digits
    for (const part of ["a.id::text ILIKE $2", "a.name", "a.business_legal_name", "c.name", "application_contacts", ".email ILIKE $2", "regexp_replace"]) expect(sql).toContain(part);
  });
  it("matches a phone by its last 10 digits", () => {
    expect(phoneDigits("+1 (403) 555-0123")).toBe("4035550123");
    expect(phoneDigits("555")).toBeNull();
    const values: unknown[] = [];
    pipelineSearchClause("403-555-0123", values);
    expect(values[1]).toBe("4035550123");
  });
});

describe("banking insights (v906)", () => {
  const tx = (document_id: string, transaction_date: string, description: string, amount: number, balance_after: number | null, is_nsf = false) =>
    ({ document_id, transaction_date, description, amount, balance_after, is_nsf });
  const rows = [
    tx("d1", "2026-01-02", "Opening deposit SALES", 5000, 5000),
    tx("d1", "2026-01-15", "PREAUTHORIZED DEBIT ONDECK CAPITAL", -1200, 3800),
    tx("d1", "2026-01-20", "NSF FEE", -48, -100, true),
    tx("d1", "2026-01-31", "DEPOSIT CLIENT ABC", 2000, 1900),
    tx("d2", "2026-02-03", "PAYMENT TO ACME SUPPLY #4432", -900, 1000),
    tx("d2", "2026-02-15", "PREAUTHORIZED DEBIT ONDECK CAPITAL", -1200, -200),
    tx("d2", "2026-02-27", "DEPOSIT CLIENT ABC", 3000, 2800),
  ];
  const ins = buildBankingInsights(rows);
  it("builds the monthly trend from the transactions", () => {
    expect(ins.months.map((m) => m.month)).toEqual(["2026-01-01", "2026-02-01"]);
    expect(ins.months[0]).toMatchObject({ deposits: 7000, withdrawals: 1248, net: 5752, nsfCount: 1, endingBalance: 1900, daysNegative: 1 });
    expect(ins.months[1]).toMatchObject({ deposits: 3000, withdrawals: 2100, daysNegative: 1 });
    expect(ins.months[0]!.averageBalance).not.toBeNull();
  });
  it("reports what the OCR read for each statement", () => {
    const d1 = ins.statements.find((s) => s.document_id === "d1")!;
    expect(d1).toMatchObject({ periodStart: "2026-01-02", periodEnd: "2026-01-31", openingBalance: 0, closingBalance: 1900, deposits: 7000, withdrawals: 1248, transactionCount: 4, nsfCount: 1 });
  });
  it("counts NSFs and negative days, and finds lender payments, payees and payors", () => {
    expect(ins.nsfCount).toBe(1);
    expect(ins.daysNegative).toBe(2);
    expect(ins.lenderPayments[0]).toMatchObject({ count: 2, total: 2400, months: 2 });
    expect(ins.lenderPayments[0]!.name).toContain("ONDECK");
    expect(ins.topPayors.find((p) => p.name === "CLIENT ABC")).toMatchObject({ total: 5000, count: 2 });
    expect(ins.topPayees.some((p) => p.name === "ACME SUPPLY")).toBe(true);
  });
  it("only flags withdrawals that look like lender payments", () => {
    expect(looksLikeLenderPayment("LOAN PMT RBC", -500)).toBe(true);
    expect(looksLikeLenderPayment("LOAN PMT RBC", 500)).toBe(false);
    expect(looksLikeLenderPayment("Interest earned", -1)).toBe(false);
    expect(looksLikeLenderPayment("COSTCO WHOLESALE", -300)).toBe(false);
    expect(counterparty("POS PURCHASE 0912 TIM HORTONS #123")).toBe("TIM HORTONS");
  });
});

describe("OCR mime type (v906)", () => {
  it("comes from the file name, then the bytes", () => {
    expect(mimeFromFileName("Statement Jan.PDF")).toBe("application/pdf");
    expect(mimeFromFileName("scan.jpeg ")).toBe("image/jpeg");
    expect(mimeFromFileName("noext")).toBeNull();
    expect(sniffMimeType(Buffer.from("%PDF-1.7\n..."))).toBe("application/pdf");
    expect(sniffMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
    expect(sniffMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png");
    expect(resolveMimeType({ stored: "application/pdf", fileNames: ["a.png"] })).toEqual({ mimeType: "application/pdf", inferred: false });
    expect(resolveMimeType({ stored: "", fileNames: [null, "a.png"] })).toEqual({ mimeType: "image/png", inferred: true });
    expect(resolveMimeType({ stored: undefined, fileNames: ["blob"], buffer: Buffer.from("%PDF-1.4") })).toEqual({ mimeType: "application/pdf", inferred: true });
    expect(resolveMimeType({ fileNames: [], buffer: Buffer.from("hello") })).toEqual({ mimeType: null, inferred: false });
  });
  it("the migration fills in missing types and re-queues the failed jobs, idempotently", () => {
    const sql = readFileSync("migrations/2026_11_21_v906_application_file.sql", "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS credit_summary_steps");
    expect(sql).toContain("WHERE COALESCE(dv.metadata->>'mimeType', '') = ''");
    expect(sql).toContain("WHERE last_error = 'missing_document_mime_type'");
  });
});

describe("credit summary steps (v906)", () => {
  it("shows every step, not run until it has run, and a stale run as failed", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    const v = stepView([
      { step: "financials", status: "done", message: "Read 2", started_at: "2026-11-06T11:00:00Z", finished_at: "2026-11-06T11:01:00Z" },
      { step: "research", status: "running", message: null, started_at: "2026-11-06T11:00:00Z", finished_at: null },
      { step: "generate", status: "running", message: null, started_at: "2026-11-06T11:58:00Z", finished_at: null },
    ], now);
    expect(v.map((s) => [s.step, s.status])).toEqual([["financials", "done"], ["collateral", "not_run"], ["research", "failed"], ["generate", "running"]]);
  });
  it("accountant-prepared statements count as financial statements", () => {
    expect(kindOf("Compilation engagement report 2025")).toBe("financial_statements");
    expect(kindOf("Notice to Reader FY2024")).toBe("financial_statements");
    expect(kindOf("PnL – Interim financials")).toBe("financial_statements");
    expect(kindOf("Balance Sheet – Interim financials")).toBe("financial_statements");
    expect(kindOf("A/R")).toBe("accounts_receivable_aging");
    expect(kindOf("6 months business banking statements")).toBe("bank_statements_6_months");
  });
});

describe("SBA only for SBA or US files (v906)", () => {
  it("a Canadian start-up is not SBA; an SBA product or purpose is", () => {
    expect(sbaFromApplication("Start up", null, { business: { province: "AB" } })).toBe(false);
    expect(sbaFromApplication("start-up", null, {})).toBe(false);
    expect(sbaFromApplication("Start up", null, { business: { country: "US" } })).toBe(true);
    expect(sbaFromApplication("Start up", null, { business: { postalCode: "90210" } })).toBe(true);
    expect(sbaFromApplication("Working capital", "SBA", { business: { province: "AB" } })).toBe(true);
    expect(sbaFromApplication("SBA 7(a) loan", null, {})).toBe(true);
    expect(sbaFromApplication("Equipment", "EQUIPMENT", null)).toBe(false);
    expect(isCanadianMetadata({ kyc: { postalCode: "T6X 1G9" } })).toBe(true);
  });
});

describe("fraud score floor (v906)", () => {
  const allowed = new Set(["fraud_1", "fraud_2", "fraud_5"]);
  const r = (check_key: string, subject: string, status: StoredResult["status"]): StoredResult => ({ check_key, subject, status, reasons: [{ code: "x", severity: status === "red" ? "red" : "info", text: "t" }] });
  it("a tampered bank statement holds the score in High risk", () => {
    const docs = [{ id: "bank1", category: "6 months business banking statements" }, { id: "id1", category: "2 pieces of Government Issued ID" }];
    const s = computeScore([r("fraud_1", "bank1", "red"), r("fraud_5", "", "green")], allowed, { bankStatementIds: bankStatementIds(docs) });
    expect(s.score).toBeGreaterThanOrEqual(TAMPER_FLOOR);
    expect(s.band).toBe("high");
    expect(s.floor?.applied).toBe(true);
    expect(s.reasons[0]!.text).toContain("bank statement");
  });
  it("a tamper finding on another document is scored as before", () => {
    const s = computeScore([r("fraud_1", "id1", "red")], allowed, { bankStatementIds: new Set(["bank1"]) });
    expect(s.score).toBe(30);
    expect(s.floor?.applied).toBe(false);
  });
  it("is not final while checks run or documents wait for their scan", () => {
    expect(computeScore([], allowed, { queued: true }).complete).toBe(false);
    expect(computeScore([], allowed, { pendingDocuments: 2 }).pending_reason).toContain("2 document(s)");
    expect(computeScore([], allowed, {}).complete).toBe(true);
  });
});

describe("offer reader (v906)", () => {
  it("normalizes what the model returns", () => {
    const o = normalizeOffer({
      lender_name: " Acme  Capital ", amount: "$250,000", rate: "0.0899", rate_kind: "interest_rate", term_months: "60", payment_amount: "5,190.12",
      payment_frequency: "Bi-weekly", expiry_date: "2026-12-01", fees: [{ label: "Admin fee", amount: "495" }, { label: "", amount: 5 }],
      conditions: [{ title: "Signed personal guarantee", owner: "client", requires_document: true }, { title: "signed personal guarantee" }, { title: "" }],
    });
    expect(o).toMatchObject({ lender_name: "Acme Capital", amount: 250000, rate: 8.99, rate_kind: "interest_rate", term_months: 60, payment_amount: 5190.12, payment_frequency: "biweekly", expiry_date: "2026-12-01" });
    expect(o.fees).toEqual([{ label: "Admin fee", amount: 495 }]);
    expect(o.conditions).toEqual([{ title: "Signed personal guarantee", description: null, owner: "client", requires_document: true }]);
    expect(normalizeOffer({ rate: 1.32 }).rate_kind).toBe("factor_rate");
    expect(normalizeOffer(null).conditions).toEqual([]);
  });
  it("reads text then asks for the fields; an empty file says so", async () => {
    const ask = vi.fn(async () => ({ amount: 1000, conditions: [{ title: "Void cheque" }] }));
    const r = await readOfferDocument(Buffer.from("x"), "application/pdf", { text: async () => "Approval letter ".repeat(10), ask });
    expect(r.offer.amount).toBe(1000);
    expect(ask).toHaveBeenCalledOnce();
    await expect(readOfferDocument(Buffer.from("x"), "application/pdf", { text: async () => "  ", ask })).rejects.toThrow(/No text could be read/);
    await expect(readOfferDocument(Buffer.from("x"), "application/zip", { text: async () => "", ask })).rejects.toThrow(/PDF, a Word file \(\.docx\) or a photo/);
  });
  // BF_SERVER_v934_OFFER_READER_WORD
  it("reads a Word (.docx) term sheet", async () => {
    const ask = vi.fn(async () => ({ amount: 1040000, conditions: [{ title: "Executed loan agreement" }] }));
    const r = await readOfferDocument(Buffer.from("x"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", { text: async () => "Term sheet commitment amount ".repeat(5), ask });
    expect(r.offer.amount).toBe(1040000);
    expect(r.offer.conditions[0].title).toBe("Executed loan agreement");
  });
  it("pulls the text out of a real .docx", async () => {
    const { defaultOfferReaderDeps, DOCX_MIME } = await import("../brokerTools/offerReader.js");
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file("word/document.xml", '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Commitment Amount 1,040,000 conditions precedent</w:t></w:r></w:p></w:body></w:document>');
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    expect(await defaultOfferReaderDeps().text(buf, DOCX_MIME)).toContain("Commitment Amount 1,040,000");
  });
});
