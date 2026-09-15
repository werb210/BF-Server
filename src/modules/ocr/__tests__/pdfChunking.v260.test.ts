// BF_SERVER_OCR_LARGE_PDF_v260
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { extractPdfInChunks, isContextLengthError, isRetryableOcrError, pdfPageCount } from "../pdfChunking.js";
import { resolveExpectedDocumentKey, checkAgainstExpected } from "../../../services/documents/classifyDocument.js";

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}
const tooLong = new Error('openai_ocr_failed:400:{"error":{"message":"Your input exceeds the context window of this model.","code":"context_length_exceeded"}}');

describe("reading large PDFs in page ranges", () => {
  it("sends small PDFs in one request, as before", async () => {
    const once = vi.fn(async () => ({ text: "all", fields: { a: 1 } }));
    const r = await extractPdfInChunks(await makePdf(3), once);
    expect(once).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ text: "all", chunks: 1, pages: 3 });
  });

  it("reads a 20-page return as 8 + 8 + 4 pages and joins the text in order", async () => {
    const seen: number[] = [];
    const once = vi.fn(async (pdf: Buffer) => {
      const n = (await pdfPageCount(pdf)) as number;
      seen.push(n);
      return { text: `part${seen.length}`, fields: seen.length === 1 ? { business_name: "Voss Events" } : { business_name: "other", tax_year: 2023 } };
    });
    const r = await extractPdfInChunks(await makePdf(20), once);
    expect(seen).toEqual([8, 8, 4]);
    expect(r.text).toBe("part1\n\npart2\n\npart3");
    expect(r.fields).toEqual({ business_name: "Voss Events", tax_year: 2023 });
    expect(r.chunks).toBe(3);
  });

  it("halves any range that is still too large", async () => {
    const once = vi.fn(async (pdf: Buffer) => {
      const n = (await pdfPageCount(pdf)) as number;
      if (n > 2) throw tooLong;
      return { text: `${n}p`, fields: null };
    });
    const r = await extractPdfInChunks(await makePdf(8), once);
    expect(r.chunks).toBe(4);
    expect(r.text).toBe("2p\n\n2p\n\n2p\n\n2p");
  });

  it("does not swallow other errors", async () => {
    const once = vi.fn(async () => { throw new Error("openai_ocr_failed:401:bad key"); });
    await expect(extractPdfInChunks(await makePdf(20), once)).rejects.toThrow("401");
  });

  it("recognises permanent errors so they are not retried", () => {
    expect(isContextLengthError(tooLong)).toBe(true);
    expect(isRetryableOcrError(tooLong)).toBe(false);
    expect(isRetryableOcrError(new Error("openai_ocr_failed:429:slow down"))).toBe(true);
    expect(isRetryableOcrError(new Error("openai_ocr_failed:503:busy"))).toBe(true);
    expect(isRetryableOcrError(new Error("This operation was aborted"))).toBe(true);
  });
});

describe("requirement labels resolve to the keys the classifier uses", () => {
  it("maps the labels shown in the portal", () => {
    expect(resolveExpectedDocumentKey("6 months business banking statements")).toBe("bank_statements_6_months");
    expect(resolveExpectedDocumentKey("3 years accountant prepared financials")).toBe("financial_statements");
    expect(resolveExpectedDocumentKey("PnL – Interim financials")).toBe("financial_statements");
    expect(resolveExpectedDocumentKey("A/R")).toBe("accounts_receivable_aging");
    expect(resolveExpectedDocumentKey("bank_statements")).toBe("bank_statements_6_months");
  });
  it("a correctly filed bank statement is no longer reported as a mismatch", () => {
    const bank = "Statement period Jan 1 - Jan 31. Opening balance 12,450.00. Deposits 8,100.00. Withdrawals 6,300.00. Closing balance 14,250.00. Account number 1234. Transit 00012.";
    const verdict = checkAgainstExpected(bank, "6 months business banking statements");
    expect(verdict.mismatch).toBe(false);
  });
});

describe("wiring", () => {
  it("the OpenAI provider reads PDFs through the chunker and skips pointless retries", () => {
    const provider = fs.readFileSync("src/modules/ocr/ocr.provider.ts", "utf8");
    expect(provider).toContain("extractPdfInChunks(params.buffer");
    expect(provider).toContain("{ shouldRetry: isRetryableOcrError }");
    expect(provider).not.toContain("bufferBase64: params.buffer.toString");
  });
});
