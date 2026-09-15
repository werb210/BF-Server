// BF_SERVER_RENAME_ON_ACCEPT_v264
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { loadNamingContext, periodFromFilename, sanitizeDisplayName, suggestDocumentName, uniqueDisplayName } from "../documentNaming.js";

const biz = "Voss Events Inc";

describe("suggested names for the Voss Events documents", () => {
  it("bank statements use the statement month", () => {
    expect(suggestDocumentName({ businessName: biz, category: "6 months business banking statements", filename: "20260831-statements-5274-.pdf" }))
      .toBe("Voss Events Inc - Bank Statement - 2026-08.pdf");
  });
  it("interim financials keep the exact date and say which statement", () => {
    expect(suggestDocumentName({ businessName: biz, category: "PnL – Interim financials", filename: "Profit and Loss 4.30.26 (1).pdf" }))
      .toBe("Voss Events Inc - Profit and Loss - 2026-04-30.pdf");
    expect(suggestDocumentName({ businessName: biz, category: "Balance Sheet – Interim financials", filename: "Voss Events Balance Sheet - 4.30.26 (1).pdf" }))
      .toBe("Voss Events Inc - Balance Sheet - 2026-04-30.pdf");
  });
  it("a tax return OCR recognised is named as a tax return even when filed under financials", () => {
    expect(suggestDocumentName({ businessName: biz, category: "3 years accountant prepared financials", detectedType: "tax_returns", filename: "2022 Voss Events Tax Return.pdf" }))
      .toBe("Voss Events Inc - Tax Return - 2022.pdf");
  });
  it("leaves the period off when the filename has none", () => {
    expect(suggestDocumentName({ businessName: biz, category: "6 months business banking statements", filename: "Sept 1-11.pdf" }))
      .toBe("Voss Events Inc - Bank Statement.pdf");
    expect(periodFromFilename("statement.pdf", true)).toBeNull();
  });
});

describe("names staff type", () => {
  it("strips characters that break downloads and keeps the original extension", () => {
    expect(sanitizeDisplayName('Voss / Events: "Aug"', "x.pdf")).toBe("Voss Events Aug.pdf");
    expect(sanitizeDisplayName("   ", "x.pdf")).toBeNull();
    expect(sanitizeDisplayName("Statement.xlsx", "x.pdf")).toBe("Statement.xlsx");
  });
  it("never produces two documents with the same name", () => {
    expect(uniqueDisplayName("A - Bank Statement - 2026-08.pdf", ["a - bank statement - 2026-08.pdf"])).toBe("A - Bank Statement - 2026-08 (2).pdf");
    expect(uniqueDisplayName("B.pdf", ["B.pdf", "B (2).pdf"])).toBe("B (3).pdf");
  });
});

describe("context from the database", () => {
  it("uses a confident OCR type and excludes the document itself from the uniqueness check", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "d1", application_id: "a1", filename: "2024 Voss_Events_Inc (Updated 9.13.25).pdf", display_name: null, category: "3 years accountant prepared financials", detected_type: "tax_returns", detected_confidence: 0.9, business_name: biz }] })
      .mockResolvedValueOnce({ rows: [{ name: "Voss Events Inc - Tax Return - 2025-09-13.pdf" }] });
    const ctx = await loadNamingContext("d1", query as any);
    expect(ctx?.suggestedName).toBe("Voss Events Inc - Tax Return - 2025-09-13.pdf");
    expect(ctx?.existingNames).toEqual(["Voss Events Inc - Tax Return - 2025-09-13.pdf"]);
    expect(String(query.mock.calls[1][0])).toContain("id::text <> ($2)::text");
  });
});

describe("wiring", () => {
  const portal = fs.readFileSync("src/routes/portal.ts", "utf8");
  it("accept renames only when a name is sent, after the silo check", () => {
    const accept = portal.slice(portal.indexOf('"/documents/:id/accept"'));
    expect(accept.indexOf('typeof req.body?.displayName === "string"')).toBeGreaterThan(accept.indexOf("recordSilo !== callerSilo"));
    expect(portal).toContain('"/documents/:id/suggested-name"');
    expect(portal).toContain("displayName: (classificationById.get(");
  });
  it("lender packages use the display name, the original filename otherwise", () => {
    expect(fs.readFileSync("src/services/lenders/loadPackageInputs.ts", "utf8")).toContain("COALESCE(display_name, filename, document_type, id::text) AS filename");
    expect(fs.readFileSync("migrations/2026_09_16_v264_document_display_name.sql", "utf8")).toContain("ADD COLUMN IF NOT EXISTS display_name text");
  });
});
