import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES } from "../src/auth/roles";
import { otpVerifyRequest } from "../src/__tests__/helpers/otpAuth";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";
import { __resetTwilioRateLimitsForTest } from "../src/routes/twilio";

const app = buildAppWithApiRoutes();

let phoneCounter = 910;
const nextPhone = (): string => `+1415888${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from voicemails");
  await pool.query("delete from crm_task");
  await pool.query("delete from call_logs");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from audit_events");
  await pool.query("delete from users");
  __resetTwilioRateLimitsForTest();
}

function twilioSignature(path: string, body: Record<string, string>): string {
  return getExpectedTwilioSignature(
    process.env.TWILIO_AUTH_TOKEN ?? "",
    `${process.env.BASE_URL}${path}`,
    body
  );
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

describe("dialer integration", () => {
  it("token endpoint returns JWT", async () => {
    const phone = nextPhone();
    await createUserAccount({ phoneNumber: phone, role: ROLES.STAFF });
    const login = await otpVerifyRequest(app, { phone });

    const res = await request(app || require("../src/app").default)
      .get("/api/dialer/token")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token.length).toBeGreaterThan(10);
  });

  it("token endpoint blocks users with active calls", async () => {
    const phone = nextPhone();
    const user = await createUserAccount({ phoneNumber: phone, role: ROLES.STAFF });
    const login = await otpVerifyRequest(app, { phone });

    await pool.query(
      `insert into call_logs (id, phone_number, from_number, to_number, twilio_call_sid, direction, status, staff_user_id, created_at, started_at)
       values ('c6b1808f-c38f-4919-a00d-a0042ef5dd34', '+14155550000', '+14155550000', '+14155550001', 'CA-ACTIVE-1', 'outbound', 'ringing', $1, now(), now())`,
      [user.id]
    );

    const res = await request(app || require("../src/app").default)
      .get("/api/dialer/token")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "active_call_in_progress" });
  });

  it("rate limits abusive requests", async () => {
    let lastStatus = 0;
    for (let i = 0; i < 31; i += 1) {
      const res = await request(app || require("../src/app").default)
        .post("/api/twilio/status")
        .send({ CallSid: `CA-RATE-${i}`, CallStatus: "ringing" });
      lastStatus = res.status;
    }

    expect(lastStatus).toBe(429);
  });

  it("webhook rejects invalid signature", async () => {
    const res = await request(app || require("../src/app").default)
      .post("/api/twilio/status")
      .send({ CallSid: "CA-INVALID", CallStatus: "ringing" });

    expect(res.status).toBe(403);
  });

  it("voicemail persists", async () => {
    const body = {
      RecordingUrl: "https://api.twilio.com/recordings/RE123",
      RecordingSid: "RE123",
      CallSid: "CA-VM-1",
    };

    const res = await request(app || require("../src/app").default)
      .post("/api/twilio/recording?clientId=2d5af179-6f09-4e59-a6cd-6a3a4fcba46e&callSid=CA-VM-1")
      .set("x-twilio-signature", twilioSignature("/api/twilio/recording?clientId=2d5af179-6f09-4e59-a6cd-6a3a4fcba46e&callSid=CA-VM-1", body))
      .type("form")
      .send(body);

    expect(res.status).toBe(200);
    const rows = await pool.query(
      "select call_sid, recording_sid, recording_url from voicemails where call_sid = $1",
      ["CA-VM-1"]
    );
    expect(rows.rows[0]).toMatchObject({
      call_sid: "CA-VM-1",
      recording_sid: "RE123",
      recording_url: "https://api.twilio.com/recordings/RE123",
    });
  });

  it("status updates duration, billing, and completion fields", async () => {
    await pool.query(
      `insert into call_logs (id, phone_number, from_number, to_number, twilio_call_sid, direction, status, staff_user_id, created_at, started_at)
       values ('662f61ab-1be1-4e2d-a640-c4d9d6306bb4', '+14155550000', '+14155550000', '+14155550001', 'CA-STATUS-1', 'outbound', 'initiated', null, now(), now())`
    );

    const body = { CallSid: "CA-STATUS-1", CallStatus: "completed", CallDuration: "12" };
    const res = await request(app || require("../src/app").default)
      .post("/api/twilio/status")
      .set("x-twilio-signature", twilioSignature("/api/twilio/status", body))
      .type("form")
      .send(body);

    expect(res.status).toBe(200);
    const call = await pool.query(
      "select status, duration_seconds, answered, ended_reason, price_estimate_cents from call_logs where twilio_call_sid = $1",
      ["CA-STATUS-1"]
    );
    expect(call.rows[0]).toMatchObject({
      status: "completed",
      duration_seconds: 12,
      answered: true,
      ended_reason: "completed",
      price_estimate_cents: 36,
    });
  });

  it("creates missed call crm task when unanswered and no voicemail exists", async () => {
    await pool.query(
      `insert into call_logs (id, phone_number, from_number, to_number, twilio_call_sid, direction, status, staff_user_id, created_at, started_at)
       values ('5b0ffb2f-d84d-4253-8447-2468cb922709', '+14155552222', '+14155550000', '+14155552222', 'CA-MISSED-1', 'outbound', 'initiated', '31f4ec3d-a3ac-42ff-b2df-080495d17b2b', now(), now())`
    );

    const body = { CallSid: "CA-MISSED-1", CallStatus: "no-answer" };
    const res = await request(app || require("../src/app").default)
      .post("/api/twilio/status")
      .set("x-twilio-signature", twilioSignature("/api/twilio/status", body))
      .type("form")
      .send(body);

    expect(res.status).toBe(200);
    const task = await pool.query(
      "select type, staff_id, phone_number from crm_task where phone_number = $1 order by created_at desc limit 1",
      ["+14155552222"]
    );
    expect(task.rows[0]).toMatchObject({
      type: "missed_call",
      staff_id: "31f4ec3d-a3ac-42ff-b2df-080495d17b2b",
      phone_number: "+14155552222",
    });
  });
});
