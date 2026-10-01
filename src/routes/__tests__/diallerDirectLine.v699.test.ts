// BF_SERVER_DIALLER_DIRECT_LINE_v699
import express from "express";
import request from "supertest";
import twilio from "twilio";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));
vi.mock("../../modules/calls/calls.service.js", () => ({ startCall: vi.fn(async () => ({})) }));
vi.mock("../../db.js", () => ({
  pool: {
    query: async (sql: string, params: any[] = []) => {
      if (sql.includes("SELECT direct_number FROM users WHERE id::text = $1")) {
        const map: Record<string, string> = { "todd-id": "+18254511768", "andrew-id": "+15874165992" };
        return { rows: map[String(params[0])] ? [{ direct_number: map[String(params[0])] }] : [{ direct_number: null }] };
      }
      return { rows: [] };
    },
  },
}));

const AUTH = "test-auth-token-v699";
const PATH = "/api/webhooks/twilio/voice/twiml";

async function call(params: Record<string, string>) {
  const router = (await import("../webhooks.js")).default;
  const a = express();
  a.use(express.urlencoded({ extended: true }));
  a.use("/api/webhooks", router);
  const signature = twilio.getExpectedTwilioSignature(AUTH, `https://example.com${PATH}`, params);
  const res = await request(a).post(PATH).type("form")
    .set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https").set("X-Twilio-Signature", signature)
    .send(params);
  return res.text;
}

beforeEach(() => {
  process.env.TWILIO_AUTH_TOKEN = AUTH;
  process.env.TWILIO_CALLER_ID = "+15875550000";
  delete process.env.TWILIO_MAIN_LINE_NUMBER;
});

describe("v699 dialler calls use each person's direct line", () => {
  it("Todd's call shows Todd's number", async () => {
    const xml = await call({ From: "client:todd-id", To: "+14035551234", CallSid: "CA1" });
    expect(xml).toContain('callerId="+18254511768"');
    expect(xml).toContain("+14035551234");
  });
  it("Andrew's call shows Andrew's number", async () => {
    expect(await call({ From: "client:andrew-id", To: "+14035551234", CallSid: "CA2" })).toContain('callerId="+15874165992"');
  });
  it("staff without a direct line show the 866", async () => {
    expect(await call({ From: "client:caden-id", To: "+14035551234", CallSid: "CA3" })).toContain('callerId="+18666318939"');
  });
  it("client-app calls never borrow a staff direct line or the 866", async () => {
    const xml = await call({ From: "client:client-app-123", To: "+14035551234", CallSid: "CA4" });
    expect(xml).not.toContain("+18254511768");
    expect(xml).not.toContain('callerId="+18666318939"');
  });
});
