// BF_SERVER_v848_DUPLICATE_UX - the duplicate guard matches file content on one application, never the file name.
import { describe, expect, it, vi } from "vitest";
import { assertNotDuplicate, DuplicateDocumentError, fingerprint, logDuplicateRefused } from "../duplicateDocuments.js";
import { sanitizeUploadFailure } from "../../../routes/client/uploadFailure.js";

const APP = "34e8b3ea-0000-4000-8000-000000000001";
const OTHER_APP = "34e8b3ea-0000-4000-8000-000000000002";
const first = Buffer.from("PK\x03\x04 business plan v1");
const second = Buffer.from("PK\x03\x04 business plan v2");

// A documents table holding `first` on APP, answered by what the SQL asks for (application + hash).
const query = vi.fn(async (sql: string, params: unknown[]) =>
  /FROM documents/.test(sql) && /application_id/.test(sql) && /hash = \$2/.test(sql) && params[0] === APP && params[1] === fingerprint(first)
    ? { rows: [{ id: "4496b975", category: "business_plan", filename: "Business Plan.docx", status: "uploaded" }] }
    : { rows: [] });

describe("duplicate guard", () => {
  it("refuses the identical file again on the same application", async () => {
    const err = await assertNotDuplicate(APP, Buffer.from(first), query).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateDocumentError);
    expect(err.existing.id).toBe("4496b975");
  });

  it("accepts a different file even when it has the same name", async () => {
    // The name never reaches the check: only the application and the SHA-256 of the bytes do.
    await expect(assertNotDuplicate(APP, second, query)).resolves.toBe(fingerprint(second));
  });

  it("accepts the same file on a different application", async () => {
    await expect(assertNotDuplicate(OTHER_APP, first, query)).resolves.toBe(fingerprint(first));
  });

  it("logs a refused duplicate as info, without the file name", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logDuplicateRefused(APP, "business_plan", new DuplicateDocumentError({ id: "4496b975", category: "business_plan", filename: "Business Plan.docx", status: "uploaded" }));
    const line = String(info.mock.calls[0]?.[0]);
    expect(line.startsWith("[documents] duplicate upload refused ")).toBe(true);
    expect(JSON.parse(line.slice("[documents] duplicate upload refused ".length))).toEqual({
      applicationId: APP, category: "business_plan", existingId: "4496b975", existingCategory: "business_plan", existingStatus: "uploaded",
    });
    expect(line).not.toContain("Business Plan.docx");
    info.mockRestore();
  });
});

describe("upload-failure beacon", () => {
  it("keeps a plain-words document type instead of logging null", () => {
    expect(sanitizeUploadFailure({ documentType: "articles of incorporation" }).documentType).toBe("articles of incorporation");
    expect(sanitizeUploadFailure({ documentType: "A/R aging (90 days)" }).documentType).toBe("A/R aging (90 days)");
    expect(sanitizeUploadFailure({ documentType: "<script>" }).documentType).toBeNull();
  });
});
