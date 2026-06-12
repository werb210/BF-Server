import { describe, it, expect } from "vitest";
import { resolveUploadCategory } from "../uploadCategory.js";

describe("resolveUploadCategory (BF_SERVER_BLOCK_v843)", () => {
  it("reads the legacy `category` field", () => {
    expect(resolveUploadCategory({ category: "6 months business banking statements" }))
      .toBe("6 months business banking statements");
  });
  it("reads the mini-portal DocPicker `document_type` field (the 400 fix)", () => {
    expect(resolveUploadCategory({ document_type: "bank_statements" })).toBe("bank_statements");
  });
  it("reads camelCase `documentType` too", () => {
    expect(resolveUploadCategory({ documentType: "ar_aging" })).toBe("ar_aging");
  });
  it("prefers `category` when more than one is present", () => {
    expect(resolveUploadCategory({ category: "a", document_type: "b" })).toBe("a");
  });
  it("trims whitespace", () => {
    expect(resolveUploadCategory({ document_type: "  balance_sheet  " })).toBe("balance_sheet");
  });
  it("returns null when nothing usable is present", () => {
    expect(resolveUploadCategory({})).toBeNull();
    expect(resolveUploadCategory({ category: "   " })).toBeNull();
    expect(resolveUploadCategory({ category: 123 })).toBeNull();
    expect(resolveUploadCategory(null)).toBeNull();
    expect(resolveUploadCategory(undefined)).toBeNull();
  });
});
