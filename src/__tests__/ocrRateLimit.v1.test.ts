import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isRateLimitError, rateLimitDelayMs } from "../modules/ocr/ocr.service.js";

const service = readFileSync(fileURLToPath(new URL("../modules/ocr/ocr.service.ts", import.meta.url)), "utf-8");
const mirror = readFileSync(fileURLToPath(new URL("../services/biDocMirror.ts", import.meta.url)), "utf-8");
const config = readFileSync(fileURLToPath(new URL("../config/index.ts", import.meta.url)), "utf-8");

const REAL = 'openai_ocr_failed:429: "message": "Rate limit reached for gpt-4o-mini in organization org-x on tokens per min (TPM): Limit 200000, Used 200000, Requested 6120. Please try again in 1.836s."';

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

  it("spends no attempt budget on a rate limit", () => {
    expect(service).toContain("const attemptCount = rateLimited ? job.attempt_count : job.attempt_count + 1;");
    expect(service).toContain('!rateLimited && attemptCount >= maxAttempts ? "canceled"');
  });

  it("stops two workers racing the same token bucket", () => {
    expect(config).toContain("toNumber(parsed.OCR_WORKER_CONCURRENCY, 1)");
  });

  it("treats an already-mirrored BI document as done, not failed", () => {
    expect(mirror).toContain("idx_bi_documents_app_doctype_unique");
    expect(mirror).toContain("bi_doc_mirror_already_present");
    expect(mirror).toContain("bi_already_mirrored");
  });
});
