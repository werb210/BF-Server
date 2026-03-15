import { randomUUID } from "crypto";
import request from "supertest";

import app from "../../../src/app";
import { pool } from "../../../src/db";

const TEST_PHONE = "+15555550123";
const TEST_EMAIL = "testuser@boreal.test";

describe("OTP Authentication Flow", () => {
  let otpCode: string;

  beforeEach(async () => {
    await pool.query("alter table users add column if not exists first_name text");
    await pool.query("alter table users add column if not exists last_name text");
    await pool.query("alter table users add column if not exists status text");
    await pool.query("alter table users add column if not exists last_login_at timestamptz");
    await pool.query("delete from auth_refresh_tokens");
    await pool.query("delete from otp_verifications");
    await pool.query("delete from users where phone_number = $1 or email = $2", [
      TEST_PHONE,
      TEST_EMAIL,
    ]);

    await pool.query(
      `insert into users (
        id,
        email,
        phone_number,
        phone,
        role,
        active,
        is_active,
        disabled,
        locked_until,
        phone_verified,
        status
      ) values ($1, $2, $3, $4, 'Staff', true, true, false, null, true, 'ACTIVE')`,
      [randomUUID(), TEST_EMAIL, TEST_PHONE, TEST_PHONE]
    );
  });

  test("Start OTP request", async () => {
    const res = await request(app).post("/api/auth/otp/start").send({
      phone: TEST_PHONE,
    });

    expect(res.status).toBe(200);
    expect(res.body.ok ?? res.body.success).toBe(true);
    expect(typeof res.body.data?.otp).toBe("string");
  });

  test("Verify OTP request", async () => {
    const otpResponse = await request(app).post("/api/auth/otp/start").send({
      phone: TEST_PHONE,
    });

    otpCode = otpResponse.body.data?.otp;

    const verify = await request(app).post("/api/auth/otp/verify").send({
      phone: TEST_PHONE,
      email: TEST_EMAIL,
      code: otpCode,
    });

    expect(verify.status).toBe(200);
    expect(typeof (verify.body.token ?? verify.body.accessToken)).toBe("string");
    expect(verify.body.user).toBeDefined();
  });

  test("Access protected endpoint with token", async () => {
    const otpResponse = await request(app).post("/api/auth/otp/start").send({
      phone: TEST_PHONE,
    });

    otpCode = otpResponse.body.data?.otp;

    const verify = await request(app).post("/api/auth/otp/verify").send({
      phone: TEST_PHONE,
      email: TEST_EMAIL,
      code: otpCode,
    });

    const token = verify.body.token ?? verify.body.accessToken;

    const protectedRes = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${token}`);

    expect(protectedRes.status).toBe(200);
    expect(protectedRes.body.ok).toBe(true);
    expect(protectedRes.body.user?.status).toBe("ACTIVE");
  });
});
