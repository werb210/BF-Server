import request from "supertest";
import type { Express } from "express";
import { randomUUID } from "crypto";
import { vi } from "vitest";
import { pool } from "../db";
import { ROLES, type Role } from "../auth/roles";
import { getTwilioMocks } from "../__tests__/helpers/twilioMocks";
import { otpStartRequest, otpVerifyRequest } from "../__tests__/helpers/otpAuth";
import { resetLoginRateLimit } from "../middleware/rateLimit";

import { buildAppWithApiRoutes } from "../app";
import * as config from "../config";

const TEST_PHONE = "+15555550099";

function buildTestApp(): Express {
  return buildAppWithApiRoutes();
}

async function upsertUser(params: { phone: string; role: Role }) {
  const userId = randomUUID();
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
        phone_verified
      )
     values ($1, $2, $3, $4, $5, true, true, false, null, true)
     on conflict (phone_number) do update
       set email = excluded.email,
           phone = excluded.phone,
           role = excluded.role,
           active = excluded.active,
           is_active = excluded.is_active,
           disabled = excluded.disabled,
           locked_until = excluded.locked_until,
           phone_verified = excluded.phone_verified`,
    [userId, `otp-flow-${userId}@example.com`, params.phone, params.phone, params.role]
  );
  return { userId };
}

describe("auth otp flow regression coverage", () => {
  let originalEnv: NodeJS.ProcessEnv;

  async function resetDb(): Promise<void> {
    await pool.query("delete from auth_refresh_tokens");
    await pool.query("delete from otp_verifications");
    await pool.query("delete from users");
  }

  beforeEach(async () => {
    originalEnv = { ...process.env };
    process.env = { ...originalEnv };
    resetLoginRateLimit();
    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerification.mockReset();
    twilioMocks.createVerificationCheck.mockReset();
    twilioMocks.createVerification.mockResolvedValue({ sid: "VE_DEFAULT", status: "pending" });
    twilioMocks.createVerificationCheck.mockResolvedValue({ sid: "VC_DEFAULT", status: "approved" });
    await resetDb();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("OTP happy path works end-to-end", async () => {
    const app = buildTestApp();
    const { userId } = await upsertUser({ phone: TEST_PHONE, role: ROLES.STAFF });

    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerification.mockResolvedValueOnce({
      sid: "VE200",
      status: "pending",
    });
    twilioMocks.createVerificationCheck.mockResolvedValueOnce({
      sid: "VC200",
      status: "approved",
    });

    const start = await otpStartRequest(app, { phone: TEST_PHONE });
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ ok: true, data: { sent: true } });

    const verify = await otpVerifyRequest(app, { phone: TEST_PHONE });
    expect(verify.status).toBe(200);
    expect(typeof verify.body.accessToken).toBe("string");

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${verify.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.ok).toBe(true);
    expect(me.body.role).toBe("Staff");
  });

  it("OTP retry safety resets send and verify counters after success", async () => {
    process.env.LOGIN_RATE_LIMIT_MAX = "2";
    process.env.LOGIN_RATE_LIMIT_WINDOW_MS = "60000";
    const envSpy = vi.spyOn(config, "isTestEnvironment").mockReturnValue(false);

    const app = buildTestApp();
    await upsertUser({ phone: TEST_PHONE, role: ROLES.ADMIN });

    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerification.mockResolvedValue({
      sid: "VE201",
      status: "pending",
    });
    twilioMocks.createVerificationCheck
      .mockResolvedValueOnce({ sid: "VC201", status: "pending" })
      .mockResolvedValueOnce({ sid: "VC202", status: "approved" })
      .mockResolvedValueOnce({ sid: "VC203", status: "approved" });

    const start = await otpStartRequest(app, { phone: TEST_PHONE });
    expect(start.status).toBe(200);

    const firstAttempt = await otpVerifyRequest(app, {
      phone: TEST_PHONE,
      code: "000000",
    });
    expect(firstAttempt.status).toBe(400);

    const secondAttempt = await otpVerifyRequest(app, { phone: TEST_PHONE });
    expect(secondAttempt.status).toBe(200);

    const restart = await otpStartRequest(app, { phone: TEST_PHONE });
    expect(restart.status).toBe(200);
    envSpy.mockRestore();
  });

  it("auth contract enforces Authorization header only", async () => {
    const app = buildTestApp();
    await upsertUser({ phone: TEST_PHONE, role: ROLES.STAFF });

    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerificationCheck.mockResolvedValueOnce({
      sid: "VC204",
      status: "approved",
    });

    const start = await otpStartRequest(app, { phone: TEST_PHONE });
    expect(start.status).toBe(200);

    const tokenRes = await otpVerifyRequest(app, { phone: TEST_PHONE });
    expect(tokenRes.status).toBe(200);

    const missingHeader = await request(app).get("/api/auth/me");
    expect(missingHeader.status).toBe(401);

    const withHeader = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${tokenRes.body.accessToken}`);
    expect(withHeader.status).toBe(200);
  });
});
