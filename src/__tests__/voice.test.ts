import { describe, it, expect } from 'vitest';
import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { otpVerifyRequest } from "./helpers/otpAuth";
import { getTwilioMocks } from "./helpers/twilioMocks";

const app = buildAppWithApiRoutes();

let phoneCounter = 700;
const nextPhone = (): string =>
  `+1415777${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from call_logs");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from audit_events");
  await pool.query("delete from users");
}

beforeAll(() => {
  process.env.JWT_SECRET = "test-access-secret";
  process.env.NODE_ENV = "test";
});

beforeEach(async () => {
  await resetDb();
  phoneCounter = 700;
  const twilioMocks = getTwilioMocks();
  twilioMocks.createCall.mockReset();
  twilioMocks.updateCall.mockReset();
  twilioMocks.createCall.mockResolvedValue({ sid: "CA-VOICE-1", status: "queued" });
  twilioMocks.updateCall.mockResolvedValue({ sid: "CA-VOICE-1", status: "completed" });
});

afterAll(async () => {
  await pool.end();
});

describe("voice endpoints", () => {
  it("issues voice tokens for staff", async () => {
    const phone = nextPhone();
    const user = await createUserAccount({ phoneNumber: phone, role: ROLES.STAFF });
    const login = await otpVerifyRequest(app, { phone });

    const res = await request(app)
      .post("/api/voice/token")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token.length).toBeGreaterThan(10);
  });

  it("blocks unauthorized voice access", async () => {
    const res = await request(app)
      .post("/api/voice/call")
      .set("Authorization", "Bearer invalid")
      .send({ to: "+14155550123" });

    expect(res.status).toBe(401);
  });

  it("starts and ends a voice call", async () => {
    const phone = nextPhone();
    await createUserAccount({ phoneNumber: phone, role: ROLES.STAFF });
    const login = await otpVerifyRequest(app, { phone });

    const contactId = randomUUID();
    const start = await request(app)
      .post("/api/voice/call")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ to: "+14155551234", contactId });

    expect(start.status).toBe(201);
    expect(start.body.callSid).toBe("CA-VOICE-1");
    expect(start.body.call.twilio_call_sid).toBe("CA-VOICE-1");

    const end = await request(app)
      .post("/api/voice/call/hangup")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ callSid: "CA-VOICE-1" });

    expect(end.status).toBe(200);
    expect(end.body.call.status).toBe("completed");
  });

  it("starts and ends a voice call via start/end endpoints", async () => {
    const phone = nextPhone();
    await createUserAccount({ phoneNumber: phone, role: ROLES.STAFF });
    const login = await otpVerifyRequest(app, { phone });

    const contactId = randomUUID();
    const start = await request(app)
      .post("/api/voice/call/start")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ toPhone: "+14155559999", contactId });

    expect(start.status).toBe(201);
    expect(start.body.callSid).toBe("CA-VOICE-1");

    const end = await request(app)
      .post("/api/voice/call/end")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ callSid: "CA-VOICE-1", status: "completed", durationSeconds: 12 });

    expect(end.status).toBe(200);
    expect(end.body.call.status).toBe("completed");
    expect(end.body.call.duration_seconds).toBe(12);
  });

  it("prevents staff from controlling another user's call", async () => {
    const staffOnePhone = nextPhone();
    const staffTwoPhone = nextPhone();
    await createUserAccount({ phoneNumber: staffOnePhone, role: ROLES.STAFF });
    await createUserAccount({ phoneNumber: staffTwoPhone, role: ROLES.STAFF });

    const staffOneLogin = await otpVerifyRequest(app, { phone: staffOnePhone });
    const staffTwoLogin = await otpVerifyRequest(app, { phone: staffTwoPhone });

    await request(app)
      .post("/api/voice/call")
      .set("Authorization", `Bearer ${staffOneLogin.body.accessToken}`)
      .send({ to: "+14155551234" });

    const res = await request(app)
      .post("/api/voice/call/hold")
      .set("Authorization", `Bearer ${staffTwoLogin.body.accessToken}`)
      .send({ callSid: "CA-VOICE-1" });

    expect(res.status).toBe(403);
  });

  it("processes Twilio status webhooks", async () => {
    const { getExpectedTwilioSignature } = await import("twilio/lib/webhooks/webhooks");
    const phone = nextPhone();
    await createUserAccount({ phoneNumber: phone, role: ROLES.STAFF });
    const login = await otpVerifyRequest(app, { phone });

    await request(app)
      .post("/api/voice/call")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ to: "+14155551234" });

    const payload = {
      CallSid: "CA-VOICE-1",
      CallStatus: "completed",
      CallDuration: "17",
      From: "+14155550000",
      To: "+14155551234",
      ErrorCode: "12345",
      ErrorMessage: "Call failed",
    };
    const url = `${process.env.BASE_URL}/api/webhooks/twilio/voice`;
    const signature = getExpectedTwilioSignature(
      process.env.TWILIO_AUTH_TOKEN ?? "",
      url,
      payload
    );

    const webhook = await request(app)
      .post("/api/webhooks/twilio/voice")
      .set("X-Twilio-Signature", signature)
      .type("form")
      .send(payload);

    expect(webhook.status).toBe(200);

    const rows = await pool.query(
      "select status, duration_seconds, error_code, error_message from call_logs where twilio_call_sid = $1",
      ["CA-VOICE-1"]
    );
    expect(rows.rows[0]).toMatchObject({
      status: "completed",
      duration_seconds: 17,
      error_code: "12345",
      error_message: "Call failed",
    });
  });

  it("rejects invalid Twilio signatures", async () => {
    const payload = { CallSid: "CA-VOICE-1", CallStatus: "ringing" };
    const res = await request(app)
      .post("/api/webhooks/twilio/voice")
      .set("X-Twilio-Signature", "invalid")
      .type("form")
      .send(payload);

    expect(res.status).toBe(403);
  });
});
