// BF_SERVER_DEFER_OWNER2_INVITE_v1
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { postSignnowWebhook, signnowWebhookApp } from "../../__tests__/helpers/signnowWebhook.js";

const { dbQuery, linkMock, inviteMock, groupStatus, sendMock } = vi.hoisted(() => ({
  dbQuery: vi.fn(), linkMock: vi.fn(), inviteMock: vi.fn(), groupStatus: vi.fn(), sendMock: vi.fn(),
}));
vi.mock("../../db.js", () => ({ dbQuery, pool: { query: dbQuery } }));
vi.mock("../signnowClient.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isApiKeyConfigured: () => true,
  uploadDocumentWithFieldExtract: vi.fn(async () => ({ documentId: "doc-1" })),
  createDocumentGroup: vi.fn(async () => ({ groupId: "group-1" })),
  createEmbeddedGroupInvite: inviteMock,
  createEmbeddedGroupLink: linkMock,
  getDocumentGroupStatus: groupStatus,
  getSignerInviteComplete: vi.fn(async () => false),
}));
vi.mock("../sendApplicationForSignature.js", () => ({
  loadApplicationForPdf: vi.fn(async () => ({
    applicationId: "app-2", business: { legalName: "Voss Events" }, applicantEmail: "owner1@x.com", applicantName: "Brandon Voss",
    owners: [{ firstName: "Brandon", lastName: "Voss", email: "owner1@x.com" }, { firstName: "Pat", lastName: "Partner", email: "owner2@x.com" }],
  })),
}));
vi.mock("../pdfBuilder.js", () => ({ buildApplicationPdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])) }));
vi.mock("../accordPdfBuilder.js", () => ({ buildAccordPdf: vi.fn() }));
vi.mock("../blobStorage.js", () => ({ uploadSignedApplicationPdf: vi.fn(async () => ({ blobName: "b", url: "u" })) }));
vi.mock("../pnwSigning.js", () => ({ pnwSigningSatisfiedForAppSigning: vi.fn(async () => true), attachSignedPnwDocument: vi.fn(async () => ({ attached: false })) }));
vi.mock("../sba/sbaTrigger.js", () => ({ isSbaApplication: vi.fn(async () => false) }));
vi.mock("../sba/sbaSigning.js", () => ({ attachSignedSbaDocuments: vi.fn(async () => ({ attached: 0 })), sbaCombinedApplicationDocIfAllSigned: vi.fn(async () => null) }));
vi.mock("../finalizeSignedApplication.js", () => ({ finalizeSignedApplication: vi.fn(async () => undefined) }));
vi.mock("../../services/email/graphSendService.js", () => ({ sendViaGraph: sendMock }));
vi.mock("../../services/signnow/sendOfferTermSheet.js", () => ({ attachSignedTermSheet: vi.fn(async () => ({ attached: false })) }));
vi.mock("../../modules/applications/applications.service.js", () => ({ transitionPipelineState: vi.fn(async () => undefined) }));
vi.mock("../../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: vi.fn(async () => undefined) }));
vi.mock("../../services/feeAgreement/mediaFeeAgreement.js", () => ({ confirmFeeAgreementBySignNowIds: vi.fn(async () => ({ matched: false })) }));

import { getOrCreateEmbeddedSigningSession } from "../embeddedSigningSession.js";
import signnowRoutes from "../../routes/signnow.js";

const APP = "app-2";
beforeEach(() => {
  dbQuery.mockReset();
  linkMock.mockReset();
  linkMock.mockImplementation(async (_g: string, _i: string, email: string) => ({ url: `https://sign.test/${email}`, expiresAt: null }));
  inviteMock.mockReset();
  inviteMock.mockResolvedValue({ inviteId: "invite-1" });
  groupStatus.mockReset();
  groupStatus.mockResolvedValue({ signed: false, summary: "pending" });
  sendMock.mockReset();
  sendMock.mockResolvedValue({ ok: true });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete process.env.SIGNNOW_API_KEY; });

describe("owner 2 invite is deferred to the correct sequential step", () => {
  it("the invite really is sequential, one signer per step", async () => {
    // This is WHY the deferral is required - Owner 2 sits in step 2.
    const { createEmbeddedGroupInvite } = await vi.importActual<typeof import("../signnowClient.js")>("../signnowClient.js");
    process.env.SIGNNOW_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { id: "invite-9" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await createEmbeddedGroupInvite("g1", ["d1"], [
      { email: "owner1@x.com", name: "Brandon Voss", roleName: "Owner 1" },
      { email: "owner2@x.com", name: "Pat Partner", roleName: "Owner 2" },
    ]);
    const payload = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body));
    expect(payload.invites.map((s: any) => [s.order, s.signers.map((x: any) => x.email)])).toEqual([[1, ["owner1@x.com"]], [2, ["owner2@x.com"]]]);
  });

  describe("envelope creation", () => {
    beforeEach(() => {
      dbQuery.mockImplementation(answerBySql([
        [/SELECT a\.signnow_app_signed_at, a\.metadata/, { rows: [{ signnow_app_signed_at: null, metadata: {}, finalized_count: "1" }] }],
        [/SELECT COUNT\(\*\) AS n/, { rows: [{ n: "0" }] }],
      ], { rows: [], rowCount: 1 }));
    });

    it("no longer requests Owner 2's link", async () => {
      const r = await getOrCreateEmbeddedSigningSession(APP);
      expect(r).toEqual({ status: "ready", url: "https://sign.test/owner1@x.com", expiresAt: null });
      expect(inviteMock.mock.calls[0]![2].map((s: any) => s.email)).toEqual(["owner1@x.com", "owner2@x.com"]);
      expect(linkMock.mock.calls.map((c) => c[2])).toEqual(["owner1@x.com"]);
      expect((console.log as any).mock.calls.some((c: any[]) => String(c[0]).includes("Owner 2 invite deferred until Owner 1 signs"))).toBe(true);
    });

    it("records the pending invite for the webhook", async () => {
      await getOrCreateEmbeddedSigningSession(APP);
      const [pending] = callsMatching(dbQuery, /'owner2_invite_pending', true/);
      expect(pending![0]).toContain("'owner2_invite_email', $2::text");
      expect(pending![0]).toContain("'owner2_invite_name', $3::text");
      expect(pending![1]!.slice(0, 3)).toEqual([APP, "owner2@x.com", "Pat Partner"]);
      expect(JSON.parse(String(pending![1]![3]))).toEqual([{ index: 2, email: "owner2@x.com", name: "Pat Partner" }]);
    });
  });

  describe("the webhook once Owner 1 signs", () => {
    function pendingDb() {
      dbQuery.mockImplementation(answerBySql([
        [/select id, contact_id from applications where signnow_document_id/, { rows: [{ id: APP, contact_id: null }] }],
        [/owner2_invite_pending'\)::boolean/, { rows: [{ email: "owner2@x.com", name: "Pat Partner", gid: "group-1", iid: "invite-1" }] }],
      ], { rows: [], rowCount: 1 }));
    }
    const owner1Signed = () => postSignnowWebhook(signnowWebhookApp(signnowRoutes), { event: "user.document.fieldinvite.signed", document_group_id: "group-1" });

    it("mints and emails Owner 2's link", async () => {
      pendingDb();
      const res = await owner1Signed();
      expect(res.status).toBe(200);
      expect(linkMock).toHaveBeenCalledWith("group-1", "invite-1", "owner2@x.com");
      expect(sendMock.mock.calls[0]![0]).toMatchObject({ to: "owner2@x.com", subject: "Your Boreal application is ready to sign" });
      expect(sendMock.mock.calls[0]![0].bodyHtml).toContain("https://sign.test/owner2@x.com");
    });

    it("clears the pending flag only on a successful send", async () => {
      pendingDb();
      await owner1Signed();
      const [cleared] = callsMatching(dbQuery, /- 'owner2_invite_pending'/);
      expect(cleared![0]).toContain("owner2_invite_sent_at");
      expect(cleared![1]).toEqual([APP]);

      dbQuery.mockClear();
      sendMock.mockResolvedValue({ ok: false, error: "mailbox full" });
      await owner1Signed();
      expect(callsMatching(dbQuery, /- 'owner2_invite_pending'/)).toHaveLength(0);
    });

    it("a failed Owner 2 send stays visible to staff", async () => {
      pendingDb();
      sendMock.mockResolvedValue({ ok: false, error: "mailbox full" });
      const res = await owner1Signed();
      expect(res.status).toBe(200);
      const [err] = callsMatching(dbQuery, /'partner_invite_error', \$2::text/);
      expect(err![1]).toEqual([APP, "mailbox full"]);
    });
  });
});
