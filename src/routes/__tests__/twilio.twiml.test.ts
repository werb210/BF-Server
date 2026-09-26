// BF_SERVER_BLOCK_v575 - since v305 every Twilio webhook requires a valid X-Twilio-Signature,
// so these requests are signed the way Twilio signs them (real library, not the shared mock).
import express from "express";
import request from "supertest";
import twilio from "twilio";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));

const AUTH = "test-auth-token-v575-twiml";
const PATH = "/api/webhooks/twilio/voice/twiml";

describe("POST /api/webhooks/twilio/voice/twiml", () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = AUTH;
  });

  async function app() {
    const router = (await import("../webhooks.js")).default;
    const a = express();
    a.use(express.urlencoded({ extended: true }));
    a.use(express.json());
    a.use("/api/webhooks", router);
    return a;
  }


  async function post(params: Record<string, string>) {
    const signature = twilio.getExpectedTwilioSignature(AUTH, `https://example.com${PATH}`, params);
    return request(await app())
      .post(PATH)
      .type("form")
      .set("X-Forwarded-Host", "example.com")
      .set("X-Forwarded-Proto", "https")
      .set("X-Twilio-Signature", signature)
      .send(params);
  }

  it("refuses an unsigned request", async () => {
    const res = await request(await app()).post(PATH).type("form").send({ To: "+15875551234" });
    expect(res.status).toBe(403);
  });

  it("dials outbound To number", async () => {
    process.env.TWILIO_CALLER_ID = "+15875550000";
    const res = await post({ To: "+15875551234", outbound: "1" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Dial");
    expect(res.text).toContain("+15875551234");
  });

  it("falls back to voicemail TwiML for inbound without To", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Record");
    expect(res.text).toContain("no agents are available");
  });
});
