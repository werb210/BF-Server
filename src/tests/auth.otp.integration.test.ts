import { describe, it, expect } from 'vitest';
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { app } from "../server";
import { pool } from "../db";
import { ROLES, type Role } from "../auth/roles";
import { getTwilioMocks } from "../__tests__/helpers/twilioMocks";

const TEST_PHONE = "+15555550100";

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
    [userId, `otp-${userId}@example.com`, params.phone, params.phone, params.role]
  );
  return { userId };
}

describe("auth otp canary integration", () => {
  it("starts OTP, invokes Twilio send, verifies OTP, and returns role token", async () => {
    const twilioMocks = getTwilioMocks();

    const startRes = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: TEST_PHONE });

    expect([200, 204]).toContain(startRes.status);
    expect(twilioMocks.createVerification).toHaveBeenCalledTimes(1);
    expect(
      startRes.body?.accessToken ?? startRes.body?.data?.accessToken
    ).toBeUndefined();

    await upsertUser({ phone: TEST_PHONE, role: ROLES.ADMIN });

    const verifyRes = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: TEST_PHONE, code: "123456" });

    expect([200, 204]).toContain(verifyRes.status);

    const token = verifyRes.body?.accessToken;
    if (verifyRes.body && verifyRes.status !== 204) {
      expect(typeof token).toBe("string");
    }

    expect(token).toBeTruthy();

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      sub?: string;
      role?: string;
    };

    expect(decoded.sub).toBeTruthy();
    expect(decoded.role).toBeTruthy();
    expect(Object.values(ROLES)).toContain(decoded.role as Role);
    expect(decoded.role).not.toBe(decoded.role?.toLowerCase());
  });
});
