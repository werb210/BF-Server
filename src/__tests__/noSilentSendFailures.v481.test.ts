// BF_SERVER_BLOCK_v481_NO_SILENT_SEND_FAILURES
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  progressSubmission: vi.fn(async () => ({ stageA: { fired: true }, stageB: { fired: true, sentTo: [] } })),
  notifyClient: vi.fn(async (): Promise<{ channel: string; error?: string }> => ({ channel: "sms" })),
  allSentLendersPassed: vi.fn(async () => false),
  sendRejectionNoticeToClient: vi.fn(async (): Promise<{ sent: boolean; error?: string }> => ({ sent: true })),
}));

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: h.queryMock }, runQuery: h.queryMock, dbQuery: h.queryMock, query: h.queryMock };
});
vi.mock("../services/submission/orchestrator.js", () => ({
  progressSubmission: h.progressSubmission,
  readReadinessSnapshot: vi.fn(async () => ({})),
}));
vi.mock("../services/productQuestions/sendGate.js", () => ({ productQuestionsSummary: vi.fn(async () => ({ blocking: false })) }));
vi.mock("../services/notifications/notifyClient.js", () => ({ notifyClient: h.notifyClient }));
vi.mock("../services/rejectionNotice.js", () => ({
  allSentLendersPassed: h.allSentLendersPassed,
  sendRejectionNoticeToClient: h.sendRejectionNoticeToClient,
}));
// SignNow and the PDF builders: the signing modules below only need to reach their database write.
vi.mock("../signnow/signnowClient.js", () => ({
  isApiKeyConfigured: () => true,
  uploadDocumentWithFieldExtract: vi.fn(async () => ({ documentId: "doc-1" })),
  createDocumentGroup: vi.fn(async () => ({ groupId: "grp-1" })),
  createEmbeddedGroupInvite: vi.fn(async () => ({ inviteId: "inv-1" })),
  createEmbeddedGroupLink: vi.fn(async () => ({ url: "https://signnow.example/link", expiresAt: null })),
  getSignerInviteComplete: vi.fn(async () => false),
  sendGroupEmailInvite: vi.fn(async () => ({ inviteId: "inv-2" })),
  getDocumentGroupStatus: vi.fn(async () => ({ signed: false })),
  downloadDocument: vi.fn(async () => null),
}));
vi.mock("../signnow/sendApplicationForSignature.js", () => ({
  loadApplicationForPdf: vi.fn(async () => ({
    applicantEmail: "owner1@example.com",
    applicantName: "Jane Roe",
    business: { legalName: "Acme" },
    owners: [{ firstName: "Jane", lastName: "Roe", email: "owner1@example.com", phone: "" }, { firstName: "John", lastName: "Roe", email: "owner2@example.com" }],
  })),
}));
vi.mock("../signnow/pdfBuilder.js", () => ({ buildApplicationPdf: vi.fn(async () => new Uint8Array([1])) }));
vi.mock("../signnow/accordPdfBuilder.js", () => ({ buildAccordPdf: vi.fn(async () => new Uint8Array([1])) }));
vi.mock("../signnow/blobStorage.js", () => ({ uploadSignedApplicationPdf: vi.fn(async () => ({ blobName: "b", url: "u" })) }));
vi.mock("../signnow/pnwSigning.js", () => ({ pnwSigningSatisfiedForAppSigning: vi.fn(async () => true) }));
vi.mock("../signnow/sba/sbaTrigger.js", () => ({ isSbaApplication: vi.fn(async () => false) }));
vi.mock("../signnow/sba/sbaOwners.js", () => ({
  resolveSbaOwners: vi.fn(async () => [{ index: 2, fullName: "John Roe", email: "owner2@example.com" }]),
  loadSbaContext: vi.fn(async () => ({ business: {}, kyc: {}, form1919: {}, form413ByOwner: new Map() })),
}));
vi.mock("../signnow/sba/sbaFormBuilder.js", () => ({
  buildSba1919: vi.fn(async () => null), buildSba912: vi.fn(async () => null),
  buildSba413: vi.fn(async () => null), buildSba4506c: vi.fn(async () => null),
}));

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LENDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const token = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function appWith(mount: string, modPath: "../routes/submissionOrchestration.js" | "../modules/applications/applications.routes.js") {
  const router = (await import(modPath)).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  app.use(errorHandler);
  return app;
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.queryMock.mockReset();
  h.progressSubmission.mockClear();
  h.notifyClient.mockReset();
  h.notifyClient.mockResolvedValue({ channel: "sms" });
  h.allSentLendersPassed.mockReset();
  h.allSentLendersPassed.mockResolvedValue(false);
  h.sendRejectionNoticeToClient.mockReset();
  h.sendRejectionNoticeToClient.mockResolvedValue({ sent: true });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { errorSpy.mockRestore(); });

const loggedError = (text: string) => errorSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes(text));

describe("v481 send-path failures are reported", () => {
  describe("lender selection saves stop the send when an insert fails (both routes)", () => {
    beforeEach(() => {
      h.queryMock.mockImplementation(answerBySql([[/INSERT INTO application_lender_selections/, new Error("relation is locked")]]));
    });

    it("POST /lenders/send", async () => {
      const res = await request(await appWith("/api", "../routes/submissionOrchestration.js"))
        .post("/api/lenders/send").set("Authorization", `Bearer ${token()}`).send({ applicationId: APP_ID, lenderIds: [LENDER_ID] });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("lender_selection_save_failed");
      expect(res.body.failed).toEqual([{ lenderId: LENDER_ID, error: "relation is locked" }]);
      expect(h.progressSubmission).not.toHaveBeenCalled();
    });

    it("POST /applications/:id/lenders/send", async () => {
      const res = await request(await appWith("/api", "../routes/submissionOrchestration.js"))
        .post(`/api/applications/${APP_ID}/lenders/send`).set("Authorization", `Bearer ${token()}`).send({ lenderIds: [LENDER_ID] });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("lender_selection_save_failed");
      expect(h.progressSubmission).not.toHaveBeenCalled();
    });

    it("a saved selection carries on to the send", async () => {
      h.queryMock.mockImplementation(answerBySql([]));
      const res = await request(await appWith("/api", "../routes/submissionOrchestration.js"))
        .post(`/api/applications/${APP_ID}/lenders/send`).set("Authorization", `Bearer ${token()}`).send({ lenderIds: [LENDER_ID] });
      expect(res.status).toBe(200);
      expect(h.progressSubmission).toHaveBeenCalledTimes(1);
    });
  });

  describe("additional-steps SMS only reports sent when Twilio accepted it", () => {
    beforeEach(() => {
      h.queryMock.mockImplementation(answerBySql([
        [/SELECT id FROM applications WHERE id::text/, { rows: [{ id: APP_ID }] }],
        [/SELECT c\.phone FROM applications a LEFT JOIN contacts c/, { rows: [{ phone: "+15875550142" }] }],
      ]));
    });
    const requestSteps = async () => request(await appWith("/api/applications", "../modules/applications/applications.routes.js"))
      .post(`/api/applications/${APP_ID}/request-steps`).set("Authorization", `Bearer ${token()}`).send({ forms: ["networth"] });

    it("a refused text is logged and reported as not sent", async () => {
      h.notifyClient.mockResolvedValue({ channel: "none", error: "twilio 400" });
      const res = await requestSteps();
      expect(res.status).toBe(200);
      expect(res.body.sms_sent).toBe(false);
      expect(loggedError("[applications] additional-steps SMS failed")).toBe(true);
    });

    it("a thrown send is logged too", async () => {
      h.notifyClient.mockRejectedValue(new Error("twilio down"));
      const res = await requestSteps();
      expect(res.body.sms_sent).toBe(false);
      expect(loggedError("[applications] additional-steps SMS failed")).toBe(true);
    });

    it("an accepted text is reported as sent", async () => {
      const res = await requestSteps();
      expect(res.body.sms_sent).toBe(true);
      expect(h.notifyClient).toHaveBeenCalledWith(expect.objectContaining({ kind: "additional_steps", phone: "+15875550142" }));
      expect(loggedError("additional-steps SMS failed")).toBe(false);
    });
  });

  it("a failed rejection notice to the client is logged", async () => {
    h.queryMock.mockImplementation(answerBySql([
      [/row_number\(\) OVER/, { rows: [{ lender_id: LENDER_ID, ordinal: "1" }] }],
    ]));
    h.allSentLendersPassed.mockResolvedValue(true);
    h.sendRejectionNoticeToClient.mockRejectedValue(new Error("graph down"));
    const res = await request(await appWith("/api/applications", "../modules/applications/applications.routes.js"))
      .post(`/api/applications/${APP_ID}/lender-response`).set("Authorization", `Bearer ${token()}`).send({ lenderId: LENDER_ID, reason: "too small" });
    expect(res.status).toBe(200);
    expect(res.body.data.closed).toBe(true);
    expect(h.sendRejectionNoticeToClient).toHaveBeenCalledWith(APP_ID);
    expect(loggedError("[applications] rejection notice to client failed")).toBe(true);
  });

  it("owner invite queue write logs when it fails", async () => {
    delete process.env.SIGNNOW_STUB_MODE;
    h.queryMock.mockImplementation(answerBySql([
      [/AS finalized_count/, { rows: [{ signnow_app_signed_at: null, metadata: {}, finalized_count: "1" }] }],
      [/owner_invite_queue/, new Error("deadlock detected")],
    ]));
    const { getOrCreateEmbeddedSigningSession } = await import("../signnow/embeddedSigningSession.js");
    const r = await getOrCreateEmbeddedSigningSession(APP_ID);
    expect(r.status).toBe("ready");
    expect(callsMatching(h.queryMock, /owner_invite_queue/)).toHaveLength(1);
    expect(loggedError("owner invite queue NOT saved")).toBe(true);
  });

  it("SBA envelope record write logs when it fails", async () => {
    h.queryMock.mockImplementation(answerBySql([
      [/jsonb_build_object\('sba_signnow'/, new Error("deadlock detected")],
    ]));
    const { createSbaSigningSessions } = await import("../signnow/sba/sbaSigning.js");
    await createSbaSigningSessions(APP_ID);
    expect(callsMatching(h.queryMock, /jsonb_build_object\('sba_signnow'/)).toHaveLength(1);
    expect(loggedError("envelope record NOT saved")).toBe(true);
  });
});
