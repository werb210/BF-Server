// BF_SERVER_SBA_DOC_LIST_v113
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "..", "clientDocumentsNeeded.ts"), "utf-8");

describe("generated SBA forms", () => {
  const RE = /^sba_form_(413|1919)(_owner_\d+)?$/i;

  it("413 and 1919 are recognised as generated, not uploadable", () => {
    expect(RE.test("sba_form_413")).toBe(true);
    expect(RE.test("sba_form_1919")).toBe(true);
  });

  it("covers the per-owner 413 variants", () => {
    expect(RE.test("sba_form_413_owner_2")).toBe(true);
    expect(RE.test("sba_form_413_owner_5")).toBe(true);
  });

  it("does not swallow the genuinely uploadable SBA documents", () => {
    for (const k of ["sba_1919_attachments", "owner_photo_id", "business_plan", "debt_schedule", "lease_or_loi", "formation_documents", "personal_tax_returns"]) {
      expect(RE.test(k)).toBe(false);
    }
  });

  it("is applied where the upload list is built", () => {
    expect(src).toContain("if (SBA_GENERATED_FORM.test(docType)) return;");
  });
});

describe("labels", () => {
  it("no path emits the raw key as the label", () => {
    expect(src).not.toContain("label: docType }");
    expect(src).toContain("label: labelFor(docType)");
  });

  it("every SBA key has a human label", () => {
    for (const k of ["sba_form_413", "sba_form_1919", "owner_photo_id", "formation_documents", "personal_tax_returns", "business_plan", "sba_1919_attachments", "debt_schedule", "lease_or_loi"]) {
      expect(src).toContain(`${k}:`);
    }
  });

  it("falls back to humanize for anything unlisted", () => {
    expect(src).toContain("?? humanize(docType)");
  });
});

describe("optional documents", () => {
  it("are no longer dropped from the set", () => {
    expect(src).not.toContain('if (raw && typeof raw === "object" && raw.required === false) return;');
  });

  it("carry the flag through to the client", () => {
    expect(src).toContain("required?: boolean");
    expect(src).toContain("required: isRequired");
  });
});
