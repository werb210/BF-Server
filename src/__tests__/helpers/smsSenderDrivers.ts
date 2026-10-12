// BF_SERVER_v789_SOURCE_GREP - drives every SMS send path in the server so tests can assert on what each one
// actually hands Twilio (sender, guard, result), instead of grepping the source for the call.
//
// The calling test file owns the mocks (vi.mock is per file). It must mock, relative to itself:
//   ../db.js                              -> { ...actual, pool: { query: queryMock }, runQuery: queryMock }
//   ../lib/sharedClients.js               -> { sharedTwilio: () => ({ messages: { create: createMock } }) }
//   ../services/twilio.js                 -> { fetchTwilioClient: () => ({ messages: { create: createMock } }) }
//   twilio                                -> default factory returning { messages: { create: createMock } }
//   ../services/push/applicantPush.js, ../modules/automation/automationEngine.js, ../services/lenderMatchCache.js
//                                         -> no-op stubs (the portal reject route fires them)
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { vi, type Mock } from "vitest";
import { answerBySql } from "./answerBySql.js";

export const LOCAL_FROM = "+15875550100";
export const CONTACT_ID = "11111111-2222-4333-8444-555555555555";
const STAFF_ID = "00000000-0000-4000-8000-0000000000a1";
const DOC_ID = "33333333-4444-4555-8666-777777777777";
const APP_ID = "22222222-3333-4444-8555-666666666666";

export type SenderName =
  | "twilio helper"
  | "staff/system SMS"
  | "notifications sms.service"
  | "portal doc rejection"
  | "staff communications"
  | "communications broadcast"
  | "marketing blasts";

/** Transactional senders: allowed the toll-free line and the branded Messaging Service. */
export const TRANSACTIONAL: SenderName[] = [
  "twilio helper",
  "staff/system SMS",
  "notifications sms.service",
  "portal doc rejection",
  "staff communications",
];
/** Marketing and bulk: must send from the plain configured number. */
export const BULK: SenderName[] = ["communications broadcast", "marketing blasts"];

export type Mocks = { queryMock: Mock; createMock: Mock };
export type DriveResult = { payload: Record<string, any> | undefined; result: unknown; error: unknown; status?: number; body?: any };

const staffToken = () => jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

async function mounted(path: string, routerModule: Promise<{ default: any }>) {
  const router = (await routerModule).default;
  const app = express();
  app.use(express.json());
  app.use(path, router);
  return app;
}

/** Sends one text to `to` through the named path and returns what reached Twilio (payload undefined = nothing sent). */
export async function driveSender(name: SenderName, to: string, { queryMock, createMock }: Mocks): Promise<DriveResult> {
  createMock.mockReset();
  createMock.mockResolvedValue({ sid: "SM1", status: "queued" });
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/UPDATE documents SET status = 'rejected'/, { rows: [{ id: DOC_ID, document_type: "bank_statement", application_id: APP_ID, status: "rejected" }] }],
    [/SELECT silo FROM applications/, { rows: [{ silo: "BF" }] }],
    [/LEFT JOIN users u ON u\.id = a\.owner_user_id/, { rows: [{ phone: to, phone_number: null, contact_id: CONTACT_ID, silo: "BF" }] }],
    [/SELECT id, phone, name FROM contacts WHERE id = ANY/, { rows: [{ id: CONTACT_ID, phone: to, name: "Jordan Lee" }] }],
  ]));
  const prevPhone = process.env.TWILIO_PHONE;
  process.env.TWILIO_FROM_NUMBER = LOCAL_FROM;
  process.env.TWILIO_PHONE = LOCAL_FROM;
  process.env.TWILIO_SMS_FROM = LOCAL_FROM;
  const out: DriveResult = { payload: undefined, result: undefined, error: undefined };
  const capture = () => { out.payload = createMock.mock.calls[0]?.[0]; return out; };
  try {
    switch (name) {
      case "twilio helper": {
        const { sendSMS } = await import("../../lib/twilio.js");
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = "production"; // sendSMS short-circuits under NODE_ENV=test
        try { out.result = await sendSMS(to, "hello"); } finally { process.env.NODE_ENV = prev; }
        return capture();
      }
      case "staff/system SMS": {
        const { sendSMS } = await import("../../services/smsService.js");
        out.result = await sendSMS(to, "hello");
        return capture();
      }
      case "notifications sms.service": {
        const { sendSms } = await import("../../modules/notifications/sms.service.js");
        out.result = await sendSms({ to, message: "hello" }, { enqueueOnFailure: false });
        return capture();
      }
      case "marketing blasts": {
        const { sendMarketingSms } = await import("../../services/marketingSms.js");
        out.result = await sendMarketingSms(to, "hello");
        return capture();
      }
      case "portal doc rejection": {
        const app = await mounted("/api/portal", import("../../routes/portal.js"));
        const res = await request(app).post(`/api/portal/documents/${DOC_ID}/reject`).set("Authorization", `Bearer ${staffToken()}`).send({ reason: "blurry" });
        out.status = res.status;
        out.body = res.body;
        // The text goes out fire-and-forget after the response: wait for the phone lookup, then let the send settle.
        await vi.waitFor(() => {
          if (!queryMock.mock.calls.some(([sql]) => /owner_user_id/.test(String(sql)))) throw new Error("phone lookup not run yet");
        });
        await new Promise((r) => setTimeout(r, 25));
        return capture();
      }
      case "staff communications": {
        const app = await mounted("/api/communications", import("../../routes/communications.js"));
        const res = await request(app).post("/api/communications/sms").set("Authorization", `Bearer ${staffToken()}`).send({ to, body: "hello" });
        out.status = res.status;
        out.body = res.body;
        return capture();
      }
      case "communications broadcast": {
        const app = await mounted("/api/communications", import("../../routes/communications.js"));
        const res = await request(app).post("/api/communications/broadcast").set("Authorization", `Bearer ${staffToken()}`)
          .send({ contactIds: [CONTACT_ID], body: "hello" });
        out.status = res.status;
        out.body = res.body;
        return capture();
      }
    }
  } catch (err) {
    out.error = err;
    return capture();
  } finally {
    delete process.env.TWILIO_FROM_NUMBER;
    delete process.env.TWILIO_SMS_FROM;
    if (prevPhone === undefined) delete process.env.TWILIO_PHONE;
    else process.env.TWILIO_PHONE = prevPhone;
  }
  return out;
}
