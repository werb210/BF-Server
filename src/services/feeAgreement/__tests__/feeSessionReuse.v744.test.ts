// BF_SERVER_FEE_SESSION_REUSE_v744
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ agreement: null as any, invite: "inv-1" as string | null, signed: false }));
const sn = vi.hoisted(() => ({
  isApiKeyConfigured: () => true,
  uploadDocumentWithFieldExtract: vi.fn(async () => ({ documentId: "doc-new" })),
  createDocumentGroup: vi.fn(async () => ({ groupId: "grp-new" })),
  createEmbeddedGroupInvite: vi.fn(async () => ({ inviteId: "inv-new" })),
  createEmbeddedGroupLink: vi.fn(async (g: string) => ({ url: "https://sign.example/" + g, expiresAt: null })),
  getDocumentGroupStatus: vi.fn(async () => ({ signed: state.signed, summary: "" })),
  sendGroupEmailInvite: vi.fn(), downloadDocument: vi.fn(),
}));
vi.mock("../../../signnow/signnowClient.js", () => sn);
vi.mock("../../../signnow/mediaFeeAgreementPdfBuilder.js", () => ({ buildMediaFeeAgreementPdf: vi.fn(async () => Buffer.from("pdf")), MEDIA_FEE_AGREEMENT_ROLE: "Signer" }));
vi.mock("../../../db.js", () => ({
  pool: { connect: vi.fn() },
  dbQuery: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT signnow_invite_id")) return { rows: [{ signnow_invite_id: state.invite }] };
    if (sql.includes("FROM media_fee_agreements WHERE application_id")) return { rows: state.agreement ? [state.agreement] : [] };
    if (sql.includes("FROM applications")) return { rows: [{ name: "Test Co", requested_amount: 100000, metadata: { applicant: { firstName: "Dana", email: "dana@example.com", phone: "4035550100" } } }] };
    if (sql.includes("FROM documents")) return { rows: [{ id: "d1" }] };
    return { rows: [] };
  }),
}));
import { createFeeAgreementSigningSession } from "../mediaFeeAgreement.js";

const base = { id: "ag1", application_id: "a1", status: "pending", signer_name: "Dana R", signer_email: "dana@example.com", signer_is_applicant: true, trigger_lender_name: null, signnow_doc_id: null, created_at: "", sent_at: null, signed_at: null, document_id: null };
beforeEach(() => { vi.clearAllMocks(); state.signed = false; state.invite = "inv-1"; });

describe("fee agreement signing session", () => {
  it("reuses the prepared agreement instead of uploading a new copy on every Review tap", async () => {
    state.agreement = { ...base, signnow_group_id: "grp-1" };
    const r = await createFeeAgreementSigningSession("a1");
    expect(r).toEqual({ status: "ready", url: "https://sign.example/grp-1" });
    expect(sn.uploadDocumentWithFieldExtract).not.toHaveBeenCalled();
  });
  it("prepares the agreement once when there is none yet", async () => {
    state.agreement = { ...base, signnow_group_id: null };
    const r = await createFeeAgreementSigningSession("a1");
    expect(r).toEqual({ status: "ready", url: "https://sign.example/grp-new" });
    expect(sn.uploadDocumentWithFieldExtract).toHaveBeenCalledTimes(1);
  });
  it("reports signed when the client already finished signing", async () => {
    state.agreement = { ...base, signnow_group_id: "grp-1" };
    state.signed = true;
    expect((await createFeeAgreementSigningSession("a1")).status).toBe("signed");
  });
  it("prepares a fresh copy if the old one can no longer be opened", async () => {
    state.agreement = { ...base, signnow_group_id: "grp-1" };
    sn.createEmbeddedGroupLink.mockImplementationOnce(async () => { throw new Error("invite cancelled"); });
    const r = await createFeeAgreementSigningSession("a1");
    expect(r).toEqual({ status: "ready", url: "https://sign.example/grp-new" });
  });
});
