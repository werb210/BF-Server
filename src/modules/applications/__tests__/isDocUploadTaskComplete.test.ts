import { describe, it, expect } from "vitest";
import { isDocUploadTaskComplete } from "../applications.routes.js";

describe("isDocUploadTaskComplete", () => {
  it("treats every document task as complete when the client has no outstanding docs", () => {
    const ctx = { uploadedCategories: [], outstandingDocsClear: true };
    expect(isDocUploadTaskComplete("upload", ctx)).toBe(true); // Gov ID — the bug case
    expect(isDocUploadTaskComplete("upload:void_cheque", ctx)).toBe(true);
  });

  it("falls back to gov-ID category match for bare 'upload' while docs still outstanding", () => {
    expect(isDocUploadTaskComplete("upload", { uploadedCategories: ["government_id"], outstandingDocsClear: false })).toBe(true);
    expect(isDocUploadTaskComplete("upload", { uploadedCategories: ["bank_statements"], outstandingDocsClear: false })).toBe(false);
  });

  it("matches an 'upload:<type>' re-upload against uploaded categories while outstanding", () => {
    expect(isDocUploadTaskComplete("upload:void_cheque", { uploadedCategories: ["VOID Cheque"], outstandingDocsClear: false })).toBe(true);
    expect(isDocUploadTaskComplete("upload:void_cheque", { uploadedCategories: ["t1_generals"], outstandingDocsClear: false })).toBe(false);
  });

  it("returns false for an empty upload:<type> token with nothing matching", () => {
    expect(isDocUploadTaskComplete("upload:", { uploadedCategories: [], outstandingDocsClear: false })).toBe(false);
  });
});
