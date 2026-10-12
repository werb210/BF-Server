// BF_SERVER_MEDIA_NO_BANK_STATEMENTS_v746 + BF_SERVER_FEE_COUNTERSIGN_v746
import { describe, it, expect, vi } from "vitest";
import { canonicalDocKey } from "../services/documentKinds.js";
import { buildMediaFeeAgreementPdf } from "../signnow/mediaFeeAgreementPdfBuilder.js";
import { computeOutstandingDocs } from "../routes/clientDocumentsNeeded.js";
import { runTamperScanTick, TAMPER_BATCH } from "../workers/tamperScanWorker.js";
import { answerBySql } from "./helpers/answerBySql.js";
import { docsNeededRules } from "./helpers/docsNeededHarness.js";
import { pdfText } from "./helpers/pdfText.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query: queryMock }, runQuery: queryMock }));
vi.mock("../signnow/sba/sbaTrigger.js", () => ({ isSbaApplication: vi.fn(async () => false) }));
vi.mock("../services/documentSharing.js", () => ({
  shareFromOtherApplications: vi.fn(async () => 0),
  sharedDocumentsFor: vi.fn(async () => []),
}));

const APP = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const BANK = ["6 months business banking statements", "bank_statements_6_months"];

describe("media fee agreement and media documents", () => {
  it("treats every name for bank statements as the same document, so the media rule removes them all", async () => {
    const key = canonicalDocKey("bank_statements_6_months");
    expect(canonicalDocKey("6 months business banking statements")).toBe(key);

    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql(docsNeededRules({ category: "MEDIA", productDocs: [...BANK, "Budget"] })));
    const media = await computeOutstandingDocs(APP);
    const types = media.required.map((d) => d.document_type);
    for (const b of BANK) expect(types).not.toContain(b);
    expect(types).toContain("Budget");

    // Only a media file loses them.
    queryMock.mockImplementation(answerBySql(docsNeededRules({ category: "TERM", productDocs: [...BANK, "Budget"] })));
    expect((await computeOutstandingDocs(APP)).required.map((d) => d.document_type)).toEqual([...BANK, "Budget"]);
  });

  it("Boreal's side of the agreement is signed when it is issued", async () => {
    const pdf = await buildMediaFeeAgreementPdf({ agreementDate: "October 4, 2026", companyName: "Test Co", clientName: "Dana R" } as any);
    expect(pdf.length).toBeGreaterThan(1000);
    const text = await pdfText(pdf);
    expect(text).toContain("/s/ Todd Werboweski");
    expect(text).toContain("Signed electronically for Boreal Financial on October 4, 2026");
  });

  it("system-signed documents are not flagged by the tamper scan", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ id: "doc-1" }] })) };
    const scan = vi.fn(async () => ({ level: "low", signals: [] }));
    expect(await runTamperScanTick(pool as any, scan as any)).toBe(1);
    const [sql, params] = (pool.query.mock.calls[0] as unknown) as [string, unknown[]];
    expect(sql).toContain("AND COALESCE(uploaded_by, '') <> 'system'");
    expect(sql).toContain("WHERE tamper_scanned_at IS NULL");
    expect(params).toEqual([TAMPER_BATCH]);
    expect(scan).toHaveBeenCalledWith("doc-1");
  });
});
