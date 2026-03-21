import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { otpVerifyRequest } from "../__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();

let idempotencyCounter = 0;
const nextIdempotencyKey = (): string => `idem-calls-${idempotencyCounter++}`;
let phoneCounter = 400;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from call_logs");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from audit_events");
  await pool.query("delete from users");
}

async function loginStaff(): Promise<{ token: string; userId: string }> {
  const phone = nextPhone();
  const user = await createUserAccount({ phoneNumber: phone, role: ROLES.STAFF });
  const res = await otpVerifyRequest(app, {
    phone,
    requestId: "calls-login",
    idempotencyKey: nextIdempotencyKey(),
  });
  return { token: res.body.accessToken as string, userId: user.id };
}

beforeAll(() => {
  process.env.JWT_SECRET = "test-access-secret";
  process.env.NODE_ENV = "test";
});

beforeEach(async () => {
  await resetDb();
  idempotencyCounter = 0;
  phoneCounter = 400;
});

afterAll(async () => {
  await pool.end();
});

describe("call logging", () => {
  it("creates a call log on start", async () => {
    const { token, userId } = await loginStaff();

    const res = await request(app)
      .post("/api/calls/start")
      .set("Authorization", `Bearer ${token}`)
      .send({
        phoneNumber: "+14155550123",
        direction: "outbound",
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.call.phone_number).toBe("+14155550123");

    const rows = await pool.query(
      "select phone_number, direction, status, staff_user_id from call_logs where id = $1",
      [res.body.call.id]
    );
    expect(rows.rows[0]).toMatchObject({
      phone_number: "+14155550123",
      direction: "outbound",
      status: "initiated",
      staff_user_id: userId,
    });
  });

  it("handles call lifecycle updates idempotently", async () => {
    const { token } = await loginStaff();

    const start = await request(app)
      .post("/api/calls/start")
      .set("Authorization", `Bearer ${token}`)
      .send({
        phoneNumber: "+14155550678",
        direction: "outbound",
      });

    const callId = start.body.call.id as string;

    const connect = await request(app)
      .post(`/api/calls/${callId}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    expect(connect.status).toBe(200);
    expect(connect.body.call.status).toBe("in_progress");

    const connectAgain = await request(app)
      .post(`/api/calls/${callId}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    expect(connectAgain.status).toBe(200);
    expect(connectAgain.body.call.status).toBe("in_progress");

    const end = await request(app)
      .post(`/api/calls/${callId}/end`)
      .set("Authorization", `Bearer ${token}`)
      .send({ durationSeconds: 42 });

    expect(end.status).toBe(200);
    expect(end.body.call.status).toBe("ended");
    expect(end.body.call.duration_seconds).toBe(42);
    expect(end.body.call.ended_at).toBeTruthy();
  });
});
