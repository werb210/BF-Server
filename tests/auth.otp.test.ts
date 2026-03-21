import { vi } from 'vitest';
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { app } from "../src";
import { pool } from "../src/db";
import { ROLES, type Role } from "../src/auth/roles";

type TwilioMockState = {
  createVerification: ReturnType<typeof vi.fn>;
  createVerificationCheck: ReturnType<typeof vi.fn>;
};

const TEST_PHONE = "+15555555555";
const FAIL_PHONE = "+15555555556";

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

function getTwilioMocks(): TwilioMockState {
  return (globalThis as typeof globalThis & { __twilioMocks: TwilioMockState })
    .__twilioMocks;
}

describe("OTP integration", () => {
  it("starts OTP verification", async () => {
    const twilioMocks = getTwilioMocks();

    const res = await request(app || require("../src/app").default)
      .post("/api/auth/otp/start")
      .send({ phone: TEST_PHONE });

    expect(res.status).toBe(200);
    expect(twilioMocks.createVerification).toHaveBeenCalledTimes(1);
  });

  it("verifies OTP and returns access token", async () => {
    await upsertUser({ phone: TEST_PHONE, role: ROLES.ADMIN });

    const res = await request(app || require("../src/app").default)
      .post("/api/auth/otp/verify")
      .send({ phone: TEST_PHONE, code: "123456" });

    const accessToken = res.body.accessToken;

    expect(res.status).toBe(200);
    expect(accessToken).toBeTruthy();

    const decoded = jwt.verify(accessToken, process.env.JWT_SECRET!) as {
      sub?: string;
      role?: string;
    };

    expect(decoded.sub).toBeTruthy();
    expect([ROLES.ADMIN, ROLES.STAFF, ROLES.LENDER, ROLES.REFERRER]).toContain(
      decoded.role
    );
  });

  it("rejects OTP verification when Twilio does not approve", async () => {
    await upsertUser({ phone: FAIL_PHONE, role: ROLES.ADMIN });
    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerificationCheck.mockResolvedValueOnce({
      status: "pending",
      sid: "VEFAIL",
    });

    const res = await request(app || require("../src/app").default)
      .post("/api/auth/otp/verify")
      .send({ phone: FAIL_PHONE, code: "123456" });

    expect(res.status).toBe(400);
  });
});
