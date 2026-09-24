// BF_SERVER_BLOCK_v464_SMS_DELIVERY
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";

const create = vi.fn();
const poolQuery = vi.fn();
vi.mock("../services/twilio.js", () => ({ fetchTwilioClient: () => ({ messages: { create: (...a: any[]) => create(...a) } }) }));
vi.mock("../db.js", () => ({ pool: { query: (...a: any[]) => poolQuery(...a) }, dbQuery: (...a: any[]) => poolQuery(...a) }));
vi.mock("../config/index.js", () => ({ config: { app: { testMode: "false" }, twilio: { from: "+18254511768", authToken: "t" } } }));
vi.mock("../middleware/twilioWebhookValidation.js", () => ({ twilioWebhookValidation: (_req: any, _res: any, next: any) => next() }));

const load = async () => (await import("../modules/notifications/sms.service.js")).sendSms;

beforeEach(() => { vi.resetModules(); create.mockReset(); poolQuery.mockReset(); poolQuery.mockResolvedValue({ rows: [] }); });

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

  it("the status callback records Twilio's result and error code", async () => {
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const router = (await import("../routes/smsRedirect.js")).default;
    const app = express(); app.use("/api/r", router);
    const res = await request(app).post("/api/r/status").type("form").send({ MessageSid: "SM1", MessageStatus: "undelivered", ErrorCode: "30034" });
    expect(res.status).toBe(204);
    const upd = poolQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE sms_deliveries"));
    expect(upd?.[1]).toEqual(["SM1", "undelivered", "30034"]);
  });

  it("the status callback now checks Twilio's signature", () => {
    const src = fs.readFileSync("src/routes/smsRedirect.ts", "utf8");
    expect(src).toContain('router.post("/status", twilioWebhookValidation,');
  });

  it("signing texts are tracked and staff can read the latest one", () => {
    expect(fs.readFileSync("src/signnow/embeddedSigningSession.ts", "utf8")).toContain('track: { kind: "owner1_signing", applicationId }');
    expect(fs.readFileSync("src/signnow/ownerSigningNotice.ts", "utf8")).toContain('track: { kind: "owner1_signing", applicationId }');
    expect(fs.readFileSync("src/routes/submissionOrchestration.ts", "utf8")).toContain('router.get("/applications/:id/signing-sms", requireAuth');
  });
});
