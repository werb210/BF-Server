// BF_SERVER_BLOCK_v464_SMS_DELIVERY
import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const create = vi.fn();
const poolQuery = vi.fn();
const notifyClient = vi.fn();
const signnow = vi.hoisted(() => ({
  isApiKeyConfigured: () => true,
  uploadDocumentWithFieldExtract: async () => ({ documentId: "doc-1" }),
  createDocumentGroup: async () => ({ groupId: "grp-1" }),
  createEmbeddedGroupInvite: async () => ({ inviteId: "inv-1" }),
  createEmbeddedGroupLink: async () => ({ url: "https://signnow.test/embedded", expiresAt: "2026-10-12T12:00:00Z" }),
  getSignerInviteComplete: async () => false,
}));
vi.mock("../services/twilio.js", () => ({ fetchTwilioClient: () => ({ messages: { create: (...a: any[]) => create(...a) } }) }));
vi.mock("../db.js", () => ({ pool: { query: (...a: any[]) => poolQuery(...a) }, dbQuery: (...a: any[]) => poolQuery(...a) }));
vi.mock("../config/index.js", () => ({ config: { app: { testMode: "false" }, twilio: { from: "+18254511768", authToken: "t" } } }));
// Stands in for Twilio's signature check: only a request carrying a valid signature gets through.
vi.mock("../middleware/twilioWebhookValidation.js", () => ({
  twilioWebhookValidation: (req: any, res: any, next: any) => (req.header("x-twilio-signature") === "valid-signature" ? next() : res.status(403).send("invalid signature")),
}));
vi.mock("../services/notifications/notifyClient.js", () => ({ notifyClient: (...a: any[]) => notifyClient(...a) }));
vi.mock("../signnow/signnowClient.js", () => signnow);
vi.mock("../signnow/sba/sbaTrigger.js", () => ({ isSbaApplication: async () => false }));
vi.mock("../signnow/pnwSigning.js", () => ({ pnwSigningSatisfiedForAppSigning: async () => true }));
vi.mock("../signnow/sendApplicationForSignature.js", () => ({
  loadApplicationForPdf: async () => ({ applicantEmail: "owner1@example.test", applicantName: "Olive Owner", owners: [{ phone: "780-555-0100" }], business: { legalName: "Olive Co" } }),
}));
vi.mock("../signnow/pdfBuilder.js", () => ({ buildApplicationPdf: async () => new Uint8Array([1, 2, 3]) }));
vi.mock("../signnow/accordPdfBuilder.js", () => ({ buildAccordPdf: async () => new Uint8Array([1]) }));
vi.mock("../signnow/blobStorage.js", () => ({ uploadSignedApplicationPdf: async () => ({ blobName: "b", url: "u" }) }));

const load = async () => (await import("../modules/notifications/sms.service.js")).sendSms;

beforeEach(() => {
  vi.resetModules();
  create.mockReset();
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [] });
  notifyClient.mockReset();
  notifyClient.mockResolvedValue({ channel: "sms" });
});

describe("v464 SMS delivery tracking", () => {
  it("asks Twilio for delivery updates and records the text", async () => {
    create.mockResolvedValue({ sid: "SM1", status: "queued" });
    const sendSms = await load();
    await sendSms({ to: "+19173043342", message: "hi", track: { kind: "owner1_signing", applicationId: "app-1" } });
    expect(create.mock.calls[0][0].statusCallback).toBe("https://server.boreal.financial/api/r/status");
    const insert = poolQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO sms_deliveries"));
    expect(insert?.[1]).toEqual(["SM1", "+19173043342", "owner1_signing", "app-1", "queued"]);
  });

  it("an untracked text is still recorded, as kind sms", async () => {
    create.mockResolvedValue({ sid: "SM2", status: "queued" });
    const sendSms = await load();
    await sendSms({ to: "+14032217788", message: "hi" });
    const insert = poolQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO sms_deliveries"));
    expect(insert?.[1]).toEqual(["SM2", "+14032217788", "sms", null, "queued"]);
  });

  it("a failed recording never fails the send", async () => {
    create.mockResolvedValue({ sid: "SM3", status: "queued" });
    poolQuery.mockRejectedValue(new Error("db down"));
    const sendSms = await load();
    await expect(sendSms({ to: "+14032217788", message: "hi" })).resolves.toMatchObject({ sid: "SM3" });
  });

  const statusApp = async () => {
    const express = (await import("express")).default;
    const router = (await import("../routes/smsRedirect.js")).default;
    const app = express(); app.use("/api/r", router);
    return app;
  };

  it("the status callback records Twilio's result and error code", async () => {
    const request = (await import("supertest")).default;
    const res = await request(await statusApp()).post("/api/r/status").set("X-Twilio-Signature", "valid-signature")
      .type("form").send({ MessageSid: "SM1", MessageStatus: "undelivered", ErrorCode: "30034" });
    expect(res.status).toBe(204);
    const upd = poolQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE sms_deliveries"));
    expect(upd?.[1]).toEqual(["SM1", "undelivered", "30034"]);
  });

  it("the status callback now checks Twilio's signature", async () => {
    const request = (await import("supertest")).default;
    const res = await request(await statusApp()).post("/api/r/status").set("X-Twilio-Signature", "forged")
      .type("form").send({ MessageSid: "SM1", MessageStatus: "delivered" });
    expect(res.status).toBe(403);
    expect(poolQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE sms_deliveries"))).toBe(false);
  });

  it("signing texts are tracked: the first signing session text", async () => {
    poolQuery.mockImplementation(answerBySql([
      [/FROM applications a WHERE a.id::text = \(\$1\)::text LIMIT 1/, { rows: [{ signnow_app_signed_at: null, metadata: {}, finalized_count: "1" }] }],
    ]));
    const { getOrCreateEmbeddedSigningSession } = await import("../signnow/embeddedSigningSession.js");
    const r = await getOrCreateEmbeddedSigningSession("app-7");
    expect(r).toMatchObject({ status: "ready" });
    expect(notifyClient).toHaveBeenCalledTimes(1);
    expect(notifyClient.mock.calls[0][0]).toMatchObject({ phone: "+17805550100", applicationId: "app-7", track: { kind: "owner1_signing", applicationId: "app-7" } });
  });

  it("signing texts are tracked: the resend staff trigger", async () => {
    poolQuery.mockImplementation(answerBySql([
      [/metadata->'applicant'->>'firstName' AS first/, { rows: [{ first: "Olive", last: "Owner", phone: "7805550100", sms_at: null }] }],
    ]));
    const { remindOwner1ToSign } = await import("../signnow/ownerSigningNotice.js");
    const r = await remindOwner1ToSign("app-8");
    expect(r).toMatchObject({ resent: true, smsSent: true });
    expect(notifyClient.mock.calls[0][0]).toMatchObject({ applicationId: "app-8", track: { kind: "owner1_signing", applicationId: "app-8" } });
  });

  it("staff can read the latest signing text", async () => {
    poolQuery.mockImplementation(answerBySql([
      [/FROM sms_deliveries/, { rows: [{ to_number: "+17805550100", status: "undelivered", error_code: "30034", created_at: "2026-10-11T10:00:00Z" }] }],
      [/metadata->'applicant'->>'firstName' AS first/, { rows: [{ first: "Olive", last: "Owner", phone: "7805550100", sms_at: null }] }],
    ]));
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const router = (await import("../routes/submissionOrchestration.js")).default;
    const app = express(); app.use(express.json()); app.use("/api", router);
    expect((await request(app).get("/api/applications/app-9/signing-sms")).status).toBe(401);
    const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    const res = await request(app).get("/api/applications/app-9/signing-sms").set("Authorization", "Bearer " + token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, name: "Olive Owner", sms: { to: "+17805550100", status: "undelivered", errorCode: "30034" } });
    expect(callsMatching(poolQuery, /FROM sms_deliveries/)[0][1]).toEqual(["app-9"]);
  });
});
