// BF_SERVER_v848_OFFICE_DOCS - the OCR provider sends Word/Excel files as text, and a file type it can never read
// stops after one try instead of failing three times.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { answerBySql } from "../../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  markOcrJobFailure: vi.fn(async () => undefined),
  pushDeadLetter: vi.fn(async () => undefined),
  logError: vi.fn(),
}));
vi.mock("../../../db", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("../../../config/index.js", async (orig) => {
  const real = await orig<typeof import("../../../config/index.js")>();
  return { ...real, config: { ...real.config, openai: { ...real.config.openai, apiKey: "test-key", ocrModel: "test-model" }, ocr: { ...real.config.ocr, timeoutMs: 5000 } } };
});
vi.mock("../../../lib/deadLetter.js", () => ({ pushDeadLetter: h.pushDeadLetter }));
vi.mock("../../applications/applications.repo.js", async (orig) => ({
  ...(await orig<typeof import("../../applications/applications.repo.js")>()),
  findDocumentById: vi.fn(async () => ({ id: "doc-1" })),
  findActiveDocumentVersion: vi.fn(async () => ({ metadata: { mimeType: "application/msword", fileName: "old.doc" }, content: "blob://old.doc" })),
}));
vi.mock("../ocr.repo.js", async (orig) => ({ ...(await orig<typeof import("../ocr.repo.js")>()), markOcrJobFailure: h.markOcrJobFailure }));
vi.mock("../../../observability/logger.js", async (orig) => ({ ...(await orig<typeof import("../../../observability/logger.js")>()), logError: h.logError }));

import { createOpenAiOcrProvider } from "../ocr.provider.js";
import { processOcrJob } from "../ocr.service.js";
import { OcrPermanentError } from "../officeText.js";

async function docx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

const fetchMock = vi.fn();
beforeEach(() => {
  h.query.mockReset(); h.query.mockImplementation(answerBySql([]));
  h.markOcrJobFailure.mockClear(); h.pushDeadLetter.mockClear(); h.logError.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: "resp-1", output_text: '{"raw_text":"","fields":{"business_name":"Acme Ltd"}}' }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("OpenAI OCR provider with office documents", () => {
  it("sends a Word document to the model as text and keeps the converted text", async () => {
    const r = await createOpenAiOcrProvider().extract({
      buffer: await docx("Acme Ltd business plan"),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileName: "plan.docx",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const content = JSON.parse(String(fetchMock.mock.calls[0][1].body)).input[0].content as Array<Record<string, unknown>>;
    expect(content.map((c) => c.type)).toEqual(["input_text", "input_text"]);
    expect(String(content[1].text)).toContain("Acme Ltd business plan");
    expect(r.text).toBe("Acme Ltd business plan");
    expect(r.json).toEqual({ fields: { business_name: "Acme Ltd" } });
    expect(r.meta).toMatchObject({ converted_from: "docx", text_truncated: false });
  });

  it("sends a CSV as text", async () => {
    await createOpenAiOcrProvider().extract({ buffer: Buffer.from("month,deposits\nJan,1000"), mimeType: "text/csv", fileName: "bank.csv" });
    const content = JSON.parse(String(fetchMock.mock.calls[0][1].body)).input[0].content;
    expect(content[1].text).toContain("Jan,1000");
  });

  it("still sends images as images", async () => {
    await createOpenAiOcrProvider().extract({ buffer: Buffer.from([1, 2, 3]), mimeType: "image/png", fileName: "id.png" });
    const content = JSON.parse(String(fetchMock.mock.calls[0][1].body)).input[0].content;
    expect(content[1].type).toBe("input_image");
  });

  it("refuses an old .doc without calling the model", async () => {
    const err = await createOpenAiOcrProvider().extract({ buffer: Buffer.from("x"), mimeType: "application/msword", fileName: "old.doc" }).catch((e) => e);
    expect(err).toBeInstanceOf(OcrPermanentError);
    expect(err.message).toBe("unsupported_mime_type:application/msword");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("OCR job with a file that can never be read", () => {
  const job = (attempt: number) => ({ id: "job-1", document_id: "doc-1", application_id: "app-1", status: "processing", attempt_count: attempt, max_attempts: 3, next_attempt_at: null, locked_at: null, locked_by: null, last_error: null, created_at: new Date(), updated_at: new Date() }) as any;
  const storage = { fetchBuffer: vi.fn(async () => Buffer.from("x")) } as any;

  it("is canceled on the first try and the document is flagged", async () => {
    const provider = { extract: vi.fn(async () => { throw new OcrPermanentError("unsupported_mime_type:application/msword"); }) } as any;
    await processOcrJob(job(0), { provider, storage });
    expect(provider.extract).toHaveBeenCalledTimes(1);
    expect(h.markOcrJobFailure).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", attemptCount: 1, status: "canceled", nextAttemptAt: null }));
    const flagged = h.query.mock.calls.filter((c) => /UPDATE documents SET ocr_status = 'failed'/.test(String(c[0])));
    expect(flagged).toHaveLength(1);
    expect(flagged[0][1]).toEqual(["doc-1"]);
    expect(h.logError).toHaveBeenCalledWith("ocr_job_failed", expect.objectContaining({ permanent: true }));
  });

  it("an ordinary failure is still retried", async () => {
    const provider = { extract: vi.fn(async () => { throw new Error("openai_ocr_failed:500:boom"); }) } as any;
    await processOcrJob(job(0), { provider, storage });
    expect(h.markOcrJobFailure).toHaveBeenCalledWith(expect.objectContaining({ attemptCount: 1, status: "failed" }));
    expect((h.markOcrJobFailure.mock.calls[0] as any)[0].nextAttemptAt).toBeInstanceOf(Date);
    expect(h.query.mock.calls.some((c) => /UPDATE documents SET ocr_status = 'failed'/.test(String(c[0])))).toBe(false);
  });

  it("a failed status sync is logged, not thrown", async () => {
    h.query.mockImplementation(answerBySql([[/UPDATE documents SET ocr_status/, new Error("db down")]]));
    const provider = { extract: vi.fn(async () => { throw new OcrPermanentError("document_has_no_text:text"); }) } as any;
    await expect(processOcrJob(job(0), { provider, storage })).resolves.toBeUndefined();
    expect(h.logError).toHaveBeenCalledWith("ocr_permanent_failure_status_sync_failed", expect.objectContaining({ documentId: "doc-1", error: "db down" }));
  });
});
