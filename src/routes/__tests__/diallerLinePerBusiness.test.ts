// BF_SERVER_DIALLER_LINE_PER_BUSINESS_v1 - a dialler call made on the BI / KS / SLF line shows that business's number.
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
        return { rows: String(params[0]) === "staff-a" ? [{ direct_number: "+15875550111" }] : [{ direct_number: null }] };
      }
      if (sql.includes("FROM settings WHERE key = $1")) {
        const key = String(params[0]);
        if (key.includes("BI")) return { rows: [{ value: "+18447976700" }] };
        if (key.includes("KS")) return { rows: [{ value: "+18665550123" }] };
        return { rows: [] };
      }
      return { rows: [] };
    },
  },
}));

const AUTH = "test-auth-token-line";
const PATH = "/api/webhooks/twilio/voice/twiml";

async function call(params: Record<string, string>) {
  const { clearSiloLineCache } = await import("../../voice/directLines.js");
  clearSiloLineCache();
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

describe("dialler line per business", () => {
  it("a call on the Insurance line shows the BI number", async () => {
    expect(await call({ From: "client:staff-a", To: "+14035551234", CallSid: "CA1", silo: "BI" })).toContain('callerId="+18447976700"');
  });
  it("a call on the Keystone line shows the KS number", async () => {
    expect(await call({ From: "client:staff-a", To: "+14035551234", CallSid: "CA2", silo: "ks" })).toContain('callerId="+18665550123"');
  });
  it("a business with no line of its own falls back to the person's direct number", async () => {
    expect(await call({ From: "client:staff-a", To: "+14035551234", CallSid: "CA3", silo: "SLF" })).toContain('callerId="+15875550111"');
  });
  it("BF, or no line sent, keeps the direct number", async () => {
    expect(await call({ From: "client:staff-a", To: "+14035551234", CallSid: "CA4", silo: "BF" })).toContain('callerId="+15875550111"');
    expect(await call({ From: "client:staff-a", To: "+14035551234", CallSid: "CA5" })).toContain('callerId="+15875550111"');
  });
});
