import express from "express";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js"; // BF_SERVER_SQL_CONTENT_MOCKS_v762
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import twilio from "twilio";
// BF_SERVER_SMS_INBOUND_SIGNED_v1 - the shared test setup mocks twilio; signing needs the real library.
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));
const AUTH = "test-auth-token-sms-inbound";
const PATH = "/api/webhooks/twilio/sms-inbound";
function signed(req: any, params: Record<string, string>) {
  const sig = twilio.getExpectedTwilioSignature(AUTH, `https://example.com${PATH}`, params);
  return req.post(PATH).type("form").set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https").set("X-Twilio-Signature", sig).send(params);
}
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock } }));

describe("smsInboundWebhook", () => {
  beforeEach(() => { queryMock.mockReset(); process.env.TWILIO_AUTH_TOKEN = AUTH; });
  async function app(){ const r=(await import("../smsInboundWebhook.js")).default; const a=express(); a.use(express.urlencoded({extended:false})); a.use("/api",r); return a; }
  it("creates conversation+message and is idempotent", async () => {
    queryMock.mockImplementation(answerBySql([[/FROM communications_conversations/, { rows:[{id:"c1"}] }]]));
    const res=await signed(request(await app()), {From:"+1",Body:"hi",MessageSid:"SM1"});
    expect(res.status).toBe(200); expect(res.text).toContain("<Response/>");
  });
  it("rejects an unsigned post (403) without touching the database", async () => {
    const res=await request(await app()).post(PATH).type("form").send({From:"+15555550123",Body:"STOP",MessageSid:"SM2"});
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });
  it("rejects a forged signature (403)", async () => {
    const res=await request(await app()).post(PATH).type("form").set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https").set("X-Twilio-Signature", "bogus").send({From:"+15555550123",Body:"STOP",MessageSid:"SM3"});
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
