// BF_SERVER_DOC_META_SIZE_v42
import { describe, expect, it } from "vitest";
import {
  resolveDocumentFilename,
  resolveDocumentMimeType,
  resolveDocumentSizeBytes,
  resolveDocumentStorageKey,
} from "../documentVersionMeta.js";

const uploaded = {
  fileName: "Q2 bank statement.pdf",
  mimeType: "application/pdf",
  sizeBytes: 481221,
  uploadedAt: "2026-08-01T00:00:00Z",
};

describe("resolveDocumentSizeBytes", () => {
  it("reads the sizeBytes key the uploader actually writes", () => {
    expect(resolveDocumentSizeBytes(uploaded)).toBe(481221);
  });
  it("still accepts the legacy size key", () => {
    expect(resolveDocumentSizeBytes({ size: 1024 })).toBe(1024);
  });
  it("falls back to the documents column, which pg returns as a string", () => {
    expect(resolveDocumentSizeBytes({}, { size_bytes: "204800" })).toBe(204800);
  });
  it("returns null rather than zero when nothing knows the size", () => {
    expect(resolveDocumentSizeBytes(null)).toBeNull();
    expect(resolveDocumentSizeBytes({ sizeBytes: 0 })).toBeNull();
  });
});

describe("resolveDocumentFilename", () => {
  it("prefers the version metadata name", () => {
    expect(resolveDocumentFilename(uploaded, { filename: "x.pdf", title: "y" })).toBe("Q2 bank statement.pdf");
  });
  it("falls back to documents.filename before the title", () => {
    expect(resolveDocumentFilename({}, { filename: "personal-net-worth.pdf", title: "Personal Net Worth" }))
      .toBe("personal-net-worth.pdf");
  });
  it("uses the title only when there is no filename anywhere", () => {
    expect(resolveDocumentFilename({}, { filename: null, title: "Personal Net Worth" })).toBe("Personal Net Worth");
  });
  it("treats blank strings as absent", () => {
    expect(resolveDocumentFilename({ fileName: "   " }, { filename: null, title: null })).toBeNull();
  });
});

describe("storage key and mime type", () => {
  it("falls back to documents.storage_key", () => {
    expect(resolveDocumentStorageKey({}, { storage_key: "blob/abc" })).toBe("blob/abc");
  });
  it("reads the mime type from version metadata", () => {
    expect(resolveDocumentMimeType(uploaded)).toBe("application/pdf");
    expect(resolveDocumentMimeType({})).toBeNull();
  });
});
