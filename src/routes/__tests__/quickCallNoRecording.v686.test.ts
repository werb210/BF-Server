// BF_SERVER_VOICE_AUDIT_v686 - Quick Calls between staff are not recorded; client calls still are.
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";

vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));
const direction = vi.hoisted(() => ({ value: "internal" as string }));
const leg = vi.hoisted(() => ({ kind: "staff" as string })); // BF_SERVER_v829_DIALER_RELIABILITY
vi.mock("../../db.js", () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("SELECT direction FROM conferences")) return { rows: [{ direction: direction.value }] };
      if (sql.includes("FROM conference_participants")) return { rows: [{ kind: leg.kind }] };
      return { rows: [] };
    }),
  },
}));

const AUTH = "test-auth-token-v686-voice";

async function joinTwiml(): Promise<string> {
  const { default: conferenceWebhooks } = await import("../conferenceWebhooks.js");
  const app = express();
  app.use("/api/webhooks/twilio", conferenceWebhooks);
  const path = "/api/webhooks/twilio/conference/join?conf=bf-test&pid=p1";
  const params = { CallSid: "CA1", From: "client:u1", To: "client:u2" };
  const signature = twilio.getExpectedTwilioSignature(AUTH, "https://example.com" + path, params);
  const res = await request(app).post(path).set("Content-Type", "application/x-www-form-urlencoded")
    .set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https").set("X-Twilio-Signature", signature).send(params);
  return res.text;
}

describe("v686 conference recording by call type", () => {
  beforeEach(() => { process.env.TWILIO_AUTH_TOKEN = AUTH; delete process.env.ENABLE_CALL_RECORDING; leg.kind = "staff"; });

  it("a staff-to-staff Quick Call is not recorded or announced", async () => {
    direction.value = "internal";
    const xml = await joinTwiml();
    expect(xml).toContain("<Conference");
    expect(xml).not.toContain("record-from-start");
    expect(xml).not.toContain("may be recorded");
  });

  it("a call with a client is still recorded with the consent notice", async () => {
    direction.value = "outbound";
    leg.kind = "pstn"; // BF_SERVER_v829_DIALER_RELIABILITY - the client hears the notice
    const xml = await joinTwiml();
    expect(xml).toContain("record-from-start");
    expect(xml).toContain("may be recorded");
    leg.kind = "staff"; // ... staff do not (it held them in silence before connecting)
    const staffXml = await joinTwiml();
    expect(staffXml).toContain("record-from-start");
    expect(staffXml).not.toContain("may be recorded");
  });
});
