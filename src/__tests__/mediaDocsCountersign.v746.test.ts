// BF_SERVER_MEDIA_NO_BANK_STATEMENTS_v746 + BF_SERVER_FEE_COUNTERSIGN_v746
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalDocKey } from "../services/documentKinds.js";
import { buildMediaFeeAgreementPdf } from "../signnow/mediaFeeAgreementPdfBuilder.js";

describe("media fee agreement and media documents", () => {
  it("treats every name for bank statements as the same document, so the media rule removes them all", () => {
    const key = canonicalDocKey("bank_statements_6_months");
    expect(canonicalDocKey("6 months business banking statements")).toBe(key);
    const src = readFileSync("src/routes/clientDocumentsNeeded.ts", "utf8");
    expect(src).toContain("BF_SERVER_MEDIA_NO_BANK_STATEMENTS_v746");
    expect(src).toContain('canonicalDocKey(required[i]!.document_type) === canonicalDocKey("bank_statements_6_months")');
  });
  it("Boreal's side of the agreement is signed when it is issued", async () => {
    const pdf = await buildMediaFeeAgreementPdf({ agreementDate: "October 4, 2026", companyName: "Test Co", clientName: "Dana R" } as any);
    expect(pdf.length).toBeGreaterThan(1000);
    const src = readFileSync("src/signnow/mediaFeeAgreementPdfBuilder.ts", "utf8");
    expect(src).toContain('drawText("/s/ Todd Werboweski"');
    expect(src).toContain('"Signed electronically for Boreal Financial on " + d.agreementDate');
  });
  it("system-signed documents are not flagged by the tamper scan", () => {
    expect(readFileSync("src/workers/tamperScanWorker.ts", "utf8")).toContain("AND COALESCE(uploaded_by, '') <> 'system'");
  });
});
