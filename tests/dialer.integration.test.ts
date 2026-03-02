import request from "supertest";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES } from "../src/auth/roles";
import { otpVerifyRequest } from "../src/__tests__/helpers/otpAuth";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";

const app = buildAppWithApiRoutes();

let phoneCounter = 910;
const nextPhone = (): string => `+1415888${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from voicemails");
  await pool.query("delete from call_logs");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from audit_events");
  await pool.query("delete from users");
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

    const res = await request(app)
      .get("/api/dialer/token")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token.length).toBeGreaterThan(10);
  });

  it("webhook rejects invalid signature", async () => {
    const res = await request(app)
      .post("/api/twilio/status")
      .send({ CallSid: "CA-INVALID", CallStatus: "ringing" });

    expect(res.status).toBe(403);
  });

  it("voicemail persists", async () => {
    const url = `${process.env.BASE_URL}/api/twilio/recording?clientId=2d5af179-6f09-4e59-a6cd-6a3a4fcba46e&callSid=CA-VM-1`;
    const body = {
      RecordingUrl: "https://api.twilio.com/recordings/RE123",
      RecordingSid: "RE123",
      CallSid: "CA-VM-1",
    };
    const signature = getExpectedTwilioSignature(
      process.env.TWILIO_AUTH_TOKEN ?? "",
      url,
      body
    );

    const res = await request(app)
      .post("/api/twilio/recording?clientId=2d5af179-6f09-4e59-a6cd-6a3a4fcba46e&callSid=CA-VM-1")
      .set("x-twilio-signature", signature)
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

  it("status updates call log", async () => {
    await pool.query(
      `insert into call_logs (id, phone_number, from_number, to_number, twilio_call_sid, direction, status, staff_user_id, created_at, started_at)
       values ('662f61ab-1be1-4e2d-a640-c4d9d6306bb4', '+14155550000', '+14155550000', '+14155550001', 'CA-STATUS-1', 'outbound', 'initiated', null, now(), now())`
    );

    const url = `${process.env.BASE_URL}/api/twilio/status`;
    const body = { CallSid: "CA-STATUS-1", CallStatus: "completed", CallDuration: "12" };
    const signature = getExpectedTwilioSignature(
      process.env.TWILIO_AUTH_TOKEN ?? "",
      url,
      body
    );

    const res = await request(app)
      .post("/api/twilio/status")
      .set("x-twilio-signature", signature)
      .type("form")
      .send(body);

    expect(res.status).toBe(200);
    const call = await pool.query(
      "select status, duration_seconds from call_logs where twilio_call_sid = $1",
      ["CA-STATUS-1"]
    );
    expect(call.rows[0]).toMatchObject({ status: "completed", duration_seconds: 12 });
  });
});
