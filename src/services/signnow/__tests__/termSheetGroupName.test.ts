// BF_SERVER_v957_OFFER_IN_APP - what SignNow shows the client: plain names, never the offer's internal id; on our own term sheet (we bought
// the deal) our name, never the lender's.
import { beforeEach, describe, it, expect, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

const h = vi.hoisted(() => ({ upload: vi.fn(), group: vi.fn(), mode: "lender" as string }));
vi.mock("../../../signnow/signnowClient.js", () => ({
  isApiKeyConfigured: () => true,
  uploadDocumentWithFieldExtract: (...a: unknown[]) => { h.upload(...a); return Promise.resolve({ documentId: "doc-1" }); },
  createDocumentGroup: (...a: unknown[]) => { h.group(...a); return Promise.resolve({ groupId: "grp-1" }); },
  createEmbeddedGroupInvite: async () => ({ inviteId: "inv-1" }),
  createEmbeddedGroupLink: async () => ({ url: "https://app.signnow.test/s/1", expiresAt: null }),
  getDocumentGroupStatus: async () => ({ signed: false, summary: "" }),
  downloadDocumentGroup: async () => new Uint8Array(),
  downloadDocument: async () => new Uint8Array(),
}));
vi.mock("../../../lib/storage/index.js", () => ({
  getStorage: () => ({ get: async () => { const d = await PDFDocument.create(); d.addPage(); return { buffer: Buffer.from(await d.save()), contentType: "application/pdf" }; } }),
}));
vi.mock("../../../brokerTools/docx.js", async (orig) => ({ ...(await orig<any>()), hasSigningTags: async () => false }));
import { sendOfferTermSheet, termSheetGroupName } from "../sendOfferTermSheet.js";

const OFFER = "87c2eae4-6cd7-47e2-af3b-4b21b197b974";
const pool: any = {
  query: async (sql: string) => {
    if (/FROM offers WHERE id::text = \$1/.test(sql)) return { rows: [{ id: OFFER, application_id: "app-1", term_sheet_blob_name: "b", document_url: null, lender_name: "Todd's lending company", term_sheet_mode: h.mode }] };
    if (/FROM applications a JOIN contacts c/.test(sql)) return { rows: [{ email: "client@example.com", first_name: "Test", last_name: "Client", name: null }] };
    return { rows: [], rowCount: 1 };
  },
};

beforeEach(() => { h.upload.mockReset(); h.group.mockReset(); h.mode = "lender"; });

describe("the names SignNow shows the client", () => {
  it("are plain words", () => {
    expect(termSheetGroupName("Todd's lending company")).toBe("Term sheet from Todd's lending company");
    expect(termSheetGroupName("  ")).toBe("Term sheet");
    expect(termSheetGroupName(null)).toBe("Term sheet");
  });
  it("name the lender and never carry the offer's id", async () => {
    const out = await sendOfferTermSheet({ pool, offerId: OFFER });
    expect(out.url).toBe("https://app.signnow.test/s/1");
    expect(h.group.mock.calls[0][1]).toBe("Term sheet from Todd's lending company");
    expect(h.upload.mock.calls[0][1]).toBe("Term sheet from Todd's lending company.pdf");
    expect(String(h.group.mock.calls[0][1]) + String(h.upload.mock.calls[0][1])).not.toContain(OFFER);
  });
  it("show our name, not the lender's, on our own term sheet", async () => {
    h.mode = "ours";
    await sendOfferTermSheet({ pool, offerId: OFFER });
    expect(h.group.mock.calls[0][1]).toBe("Term sheet from Boreal Financial");
    expect(String(h.upload.mock.calls[0][1])).not.toContain("Todd");
  });
});
