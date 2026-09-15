// BF_SERVER_OCR_LARGE_PDF_v260
// Large PDFs (full tax returns, long statements) were sent to the OCR model in a
// single request and failed with "context_length_exceeded" on every attempt.
// PDFs are now read in page ranges: 8 pages per request, and any range that is
// still too large is halved until it fits. Text is joined in page order.
import { PDFDocument } from "pdf-lib";

export const OCR_PAGES_PER_CHUNK = 8;

export type ChunkExtraction = { text: string; fields: Record<string, unknown> | null; meta?: Record<string, unknown> };
export type ExtractOnce = (pdf: Buffer, label: string) => Promise<ChunkExtraction>;

export function isContextLengthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /context_length_exceeded|exceeds the context window|maximum context length/i.test(message);
}

/** Retrying a 4xx other than 429 can never succeed; it only burns quota and time. */
export function isRetryableOcrError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const match = message.match(/openai_ocr_failed:(\d{3})/);
  if (!match) return true;
  const status = Number(match[1]);
  return status === 429 || status >= 500;
}

export async function pdfPageCount(buffer: Buffer): Promise<number | null> {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    return null;
  }
}

export async function slicePdf(buffer: Buffer, from: number, to: number): Promise<Buffer> {
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const indices = Array.from({ length: to - from }, (_, i) => from + i);
  const pages = await out.copyPages(source, indices);
  pages.forEach((page) => out.addPage(page));
  return Buffer.from(await out.save());
}

function mergeFields(target: Record<string, unknown>, next: Record<string, unknown> | null): void {
  if (!next) return;
  for (const [key, value] of Object.entries(next)) {
    const empty = target[key] === undefined || target[key] === null || target[key] === "";
    if (empty && value !== undefined && value !== null && value !== "") target[key] = value;
  }
}

/**
 * Reads a PDF in page ranges. Small PDFs (or ones pdf-lib cannot open) go in one
 * request exactly as before; a range the model rejects as too large is halved.
 */
export async function extractPdfInChunks(
  buffer: Buffer,
  extractOnce: ExtractOnce,
  pagesPerChunk: number = OCR_PAGES_PER_CHUNK,
): Promise<{ text: string; fields: Record<string, unknown>; chunks: number; pages: number | null }> {
  const pages = await pdfPageCount(buffer);
  if (pages === null || pages <= pagesPerChunk) {
    try {
      const one = await extractOnce(buffer, "all");
      return { text: one.text, fields: one.fields ?? {}, chunks: 1, pages };
    } catch (error) {
      if (pages === null || pages <= 1 || !isContextLengthError(error)) throw error;
      // fall through to splitting a short but dense document
    }
  }

  const texts: string[] = [];
  const fields: Record<string, unknown> = {};
  let chunks = 0;

  const readRange = async (from: number, to: number): Promise<void> => {
    const part = await slicePdf(buffer, from, to);
    try {
      const result = await extractOnce(part, `pages ${from + 1}-${to}`);
      chunks += 1;
      if (result.text?.trim()) texts.push(result.text.trim());
      mergeFields(fields, result.fields);
    } catch (error) {
      if (isContextLengthError(error) && to - from > 1) {
        const mid = from + Math.ceil((to - from) / 2);
        await readRange(from, mid);
        await readRange(mid, to);
        return;
      }
      throw error;
    }
  };

  const total = pages as number;
  const step = pages !== null && pages <= pagesPerChunk ? Math.max(1, Math.ceil(total / 2)) : pagesPerChunk;
  for (let start = 0; start < total; start += step) {
    await readRange(start, Math.min(total, start + step));
  }
  return { text: texts.join("\n\n"), fields, chunks, pages };
}
