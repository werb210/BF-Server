// BF_SERVER_BLOCK_v458_LENDER_EMAIL
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";
import { lenderEmail, lenderEmailSubject, formatAmount } from "../services/lenders/lenderEmail.js";

const { queryMock, sendLenderEmail } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sendLenderEmail: vi.fn(async () => ({ ok: true, deliveredTo: "lender@example.com" })),
}));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("../modules/lenderSubmissions/adapters/EmailAdapter.js", () => ({ sendLenderEmail }));
vi.mock("../services/lenders/buildApplicationPackage.js", () => ({ buildApplicationPackage: vi.fn(async () => ({ zipBuffer: Buffer.from("zip") })) }));
vi.mock("../services/lenders/loadPackageInputs.js", () => ({
  loadPackageInputs: vi.fn(async () => ({
    signedApplicationPdf: Buffer.from("signed"),
    creditSummaryPdf: Buffer.from("credit"),
    documents: [{ category: "6 months business banking statements", files: [{ filename: "stmt.pdf", content: Buffer.from("doc") }] }],
    additionalSignedDocs: [],
    fields: [
      { label: "Application Name", value: "Northern Gateway Films INC" },
      { label: "Requested Amount", value: 4201020 },
      { label: "Product Category", value: "Media Funding" },
    ],
  })),
}));
vi.mock("../services/email/resolveSignature.js", () => ({ resolveOwnerSignatureHtml: vi.fn(async () => "") }));
vi.mock("../services/lenders/qaExport.js", () => ({ buildFinalizedQaExports: vi.fn(async () => []) }));
vi.mock("../services/feeAgreement/mediaFeeAgreement.js", () => ({ ensureMediaFeeAgreement: vi.fn(async () => undefined) }));

const details = { lenderName: "Todd's lending company", applicationId: "b0461ec5-0b00-49f6-8dc5-cae91118c237", businessName: "Northern Gateway Films INC", requestedAmount: 4201020, productCategory: "Media Funding", contents: ["Signed application", "Credit summary", "6 months business banking statements", "Budget"] };
const link = { mode: "link" as const, sizeBytes: 23.2 * 1024 * 1024, url: "https://server.boreal.financial/api/public/lender-package/abc", expiresAt: new Date("2026-10-24T12:00:00Z") };
const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LENDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

beforeEach(() => { queryMock.mockReset(); sendLenderEmail.mockClear(); });

describe("v458 lender email", () => {
  it("the subject names the applicant and amount", () => { expect(lenderEmailSubject(details)).toBe("Boreal Financial application package: Northern Gateway Films INC ($4,201,020)"); expect(lenderEmailSubject({ ...details, businessName: "", requestedAmount: null })).toBe("Boreal Financial application package: application b0461ec5"); });
  it("says who is sending and what the package contains", () => { const e = lenderEmail(details, link); for (const s of ["Hello Todd's lending company team", "Northern Gateway Films INC", "$4,201,020", "Media Funding", "6 months business banking statements"]) expect(e.bodyText).toContain(s); expect(e.bodyHtml).toContain("Hello Todd's lending company team"); expect(e.bodyHtml).toContain("<li>Budget</li>"); });
  it("explains why the link is safe", () => { const e = lenderEmail(details, link); expect(e.bodyText).toContain("It goes to server.boreal.financial, Boreal Financial's own secure server"); expect(e.bodyText).toContain("not a third-party file-sharing site"); expect(e.bodyText).toContain("one standard .zip file of the application documents. There is no login, no software to install"); expect(e.bodyText).toContain("stops working on October 24, 2026"); expect(e.bodyText).toContain("reply to it or call your Boreal Financial contact"); expect(e.bodyHtml).toContain(`href="${link.url}"`); expect(e.bodyHtml).toContain("Download application package (23.2 MB zip)"); });
  it("an attached package gets the same email without the link section", () => { const e = lenderEmail(details, { mode: "attached", sizeBytes: 2 * 1024 * 1024 }); expect(e.bodyText).toContain("attached as one .zip file (2.0 MB)"); expect(e.bodyText).not.toContain("About this link"); });
  it("escapes applicant data in the HTML", () => { const e = lenderEmail({ ...details, businessName: "<script>x</script>" }, link); expect(e.bodyHtml).not.toContain("<script>"); expect(e.bodyHtml).toContain("&lt;script&gt;"); });
  it("formats amounts and ignores missing ones", () => { expect(formatAmount(4201020)).toBe("$4,201,020"); expect(formatAmount(null)).toBeNull(); expect(formatAmount(0)).toBeNull(); });

  it("dispatch uses the new subject and passes the package details", async () => {
    const { dispatchToSelected } = await import("../services/lenders/dispatchToSelected.js");
    const pool = { query: vi.fn(answerBySql([])) } as any;
    const sent = await dispatchToSelected({ pool, applicationId: APP_ID }, [
      { lender_id: LENDER_ID, name: "Todd's lending company", submission_method: "email", submission_email: "lender@example.com", api_endpoint: null, api_key_encrypted: null, google_sheet_id: null },
    ]);
    expect(sent).toEqual([LENDER_ID]);
    const arg = (sendLenderEmail.mock.calls[0] as unknown as [any])[0];
    expect(arg.subject).toBe("Boreal Financial application package: Northern Gateway Films INC ($4,201,020)");
    // The package details reach the email body.
    expect(arg.bodyText).toContain("Hello Todd's lending company team");
    expect(arg.bodyText).toContain("Media Funding");
    expect(arg.bodyText).toContain("6 months business banking statements");
  });

  it("sent-lenders reports download activity", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT silo FROM applications/, { rows: [{ silo: "BF" }] }],
      [/FROM application_packages p/, { rows: [
        { lender_id: LENDER_ID, sent_at: "2026-10-01T00:00:00Z", sent_manually: false, link_count: 1, download_count: 3, last_downloaded_at: "2026-10-02T00:00:00Z" },
        { lender_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", sent_at: "2026-10-01T00:00:00Z", sent_manually: false, link_count: null, download_count: null, last_downloaded_at: null },
      ] }],
    ]));
    const router = (await import("../modules/applications/applications.routes.js")).default;
    const { errorHandler } = await import("../middleware/errors.js");
    const app = express();
    app.use(express.json());
    app.use("/api/applications", router);
    app.use(errorHandler);
    const token = jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
    const res = await request(app).get(`/api/applications/${APP_ID}/sent-lenders`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.sent[0]).toMatchObject({ lenderId: LENDER_ID, viaLink: true, downloadCount: 3, lastDownloadedAt: "2026-10-02T00:00:00Z" });
    expect(res.body.data.sent[1]).toMatchObject({ viaLink: false, downloadCount: 0, lastDownloadedAt: null });
  });
});
