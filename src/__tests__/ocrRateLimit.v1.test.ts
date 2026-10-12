import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { isRateLimitError, rateLimitDelayMs } from "../modules/ocr/ocr.service.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  markOcrJobFailure: vi.fn(async () => undefined),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("../modules/applications/applications.repo.js", async (orig) => ({
  ...(await orig<typeof import("../modules/applications/applications.repo.js")>()),
  findDocumentById: vi.fn(async () => ({ id: "doc-1" })),
  findActiveDocumentVersion: vi.fn(async () => ({ metadata: { mimeType: "application/pdf", fileName: "s.pdf" }, content: "blob://s.pdf" })),
}));
vi.mock("../modules/ocr/ocr.repo.js", async (orig) => ({
  ...(await orig<typeof import("../modules/ocr/ocr.repo.js")>()),
  markOcrJobFailure: h.markOcrJobFailure,
}));
vi.mock("../observability/logger.js", async (orig) => ({
  ...(await orig<typeof import("../observability/logger.js")>()),
  logInfo: h.logInfo,
  logError: h.logError,
}));

const REAL = 'openai_ocr_failed:429: "message": "Rate limit reached for gpt-4o-mini in organization org-x on tokens per min (TPM): Limit 200000, Used 200000, Requested 6120. Please try again in 1.836s."';

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([]));
  h.markOcrJobFailure.mockClear(); h.logInfo.mockClear(); h.logError.mockClear();
});

describe("BF_SERVER_OCR_RATE_LIMIT_v1", () => {
  it("recognises the error the log actually carries", () => {
    expect(isRateLimitError(REAL)).toBe(true);
  });

  it("does not mistake an ordinary failure for a rate limit", () => {
    expect(isRateLimitError("document_not_found")).toBe(false);
    expect(isRateLimitError("openai_ocr_failed:500: internal error")).toBe(false);
    expect(isRateLimitError("")).toBe(false);
  });

  it("waits a full minute even when told to retry in under two seconds", () => {
    expect(rateLimitDelayMs(REAL)).toBe(60_000);
  });

  it("honours a longer wait when one is given", () => {
    expect(rateLimitDelayMs("Please try again in 2m30s")).toBe(150_000);
    expect(rateLimitDelayMs("Please try again in 90.0s")).toBe(90_000);
  });

  it("caps the wait so a job cannot be parked indefinitely", () => {
    expect(rateLimitDelayMs("Please try again in 45m0s")).toBe(600_000);
  });

  it("falls back to the floor when no wait is quoted", () => {
    expect(rateLimitDelayMs("429 rate_limit_exceeded")).toBe(60_000);
  });

  describe("spends no attempt budget on a rate limit", () => {
    const job = (attempt: number) => ({ id: "job-1", document_id: "doc-1", application_id: "app-1", status: "processing", attempt_count: attempt, max_attempts: 3, next_attempt_at: null, locked_at: null, locked_by: null, last_error: null, created_at: new Date(), updated_at: new Date() }) as any;
    const run = async (attempt: number, message: string) => {
      const { processOcrJob } = await import("../modules/ocr/ocr.service.js");
      const provider = { extract: vi.fn(async () => { throw new Error(message); }) } as any;
      const storage = { fetchBuffer: vi.fn(async () => Buffer.from("%PDF")) } as any;
      const before = Date.now();
      await processOcrJob(job(attempt), { provider, storage });
      const arg = (h.markOcrJobFailure.mock.calls[0] as unknown as [any])[0];
      return { arg, before };
    };

    it("a rate-limited job on its last attempt is deferred a minute, not canceled", async () => {
      const { arg, before } = await run(2, REAL);
      expect(arg).toMatchObject({ jobId: "job-1", attemptCount: 2, status: "failed", maxAttempts: 3 });
      expect(arg.nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(60_000);
      expect(h.logInfo).toHaveBeenCalledWith("ocr_job_rate_limited", expect.objectContaining({ jobId: "job-1", retryInMs: 60_000 }));
    });

    it("an ordinary failure still counts, and the last one cancels", async () => {
      const { arg } = await run(2, "openai_ocr_failed:500: internal error");
      expect(arg).toMatchObject({ attemptCount: 3, status: "canceled", nextAttemptAt: null });
    });
  });

  it("stops two workers racing the same token bucket", async () => {
    const { config } = await import("../config/index.js");
    // The test environment leaves OCR_WORKER_CONCURRENCY unset, so this is the default.
    expect(process.env.OCR_WORKER_CONCURRENCY).toBeUndefined();
    expect(config.ocr.workerConcurrency).toBe(1);
  });

  describe("treats an already-mirrored BI document as done, not failed", () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it("a unique-index answer from BI is logged as already present and marked mirrored", async () => {
      h.query.mockImplementation(answerBySql([[/SELECT bi_public_id FROM applications/, { rows: [{ bi_public_id: "PUB1" }] }]]));
      const fetchMock = vi.fn(async () => new Response('duplicate key value violates unique constraint "idx_bi_documents_app_doctype_unique"', { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);
      const { mirrorDocToBi } = await import("../services/biDocMirror.js");
      const r = await mirrorDocToBi({ bfApplicationId: "app-1", bfDocumentId: "doc-1", documentType: "Void cheque", fileName: "c.pdf", mimeType: "application/pdf", fileSize: 1, storageUrl: "u", uploadedByName: null });
      expect(r).toEqual({ ok: false, error: "bi_already_mirrored" });
      expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain("/applications/PUB1/documents/from-bf");
      expect(h.logInfo).toHaveBeenCalledWith("bi_doc_mirror_already_present", expect.objectContaining({ bfDocumentId: "doc-1" }));
      expect(h.logError).not.toHaveBeenCalledWith("bi_doc_mirror_http_error", expect.anything());
      expect(callsMatching(h.query, /UPDATE documents SET bi_mirrored_at = now\(\)/).map((c) => c[1])).toEqual([["doc-1"]]);
    });

    it("any other BI error is still an error", async () => {
      h.query.mockImplementation(answerBySql([[/SELECT bi_public_id FROM applications/, { rows: [{ bi_public_id: "PUB1" }] }]]));
      vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
      const { mirrorDocToBi } = await import("../services/biDocMirror.js");
      const r = await mirrorDocToBi({ bfApplicationId: "app-1", bfDocumentId: "doc-1", documentType: "Void cheque", fileName: null, mimeType: null, fileSize: null, storageUrl: null, uploadedByName: null });
      expect(r).toEqual({ ok: false, error: "bi_500" });
      expect(h.logError).toHaveBeenCalledWith("bi_doc_mirror_http_error", expect.objectContaining({ status: 500 }));
    });
  });
});
