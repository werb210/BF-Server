import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { ensureAuditEventSchema } from "../__tests__/helpers/auditSchema";
import { otpVerifyRequest } from "../__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "user-status-test";
let phoneCounter = 7500;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from audit_events");
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
}

beforeAll(async () => {
  process.env.BUILD_TIMESTAMP = "2024-01-01T00:00:00.000Z";
  process.env.COMMIT_SHA = "test-commit";
  process.env.JWT_SECRET = "test-access-secret";
  process.env.LOGIN_LOCKOUT_THRESHOLD = "2";
  process.env.LOGIN_LOCKOUT_MINUTES = "10";
  process.env.PASSWORD_MAX_AGE_DAYS = "30";
  process.env.NODE_ENV = "test";
  await ensureAuditEventSchema();
});

beforeEach(async () => {
  await resetDb();
  phoneCounter = 7500;
});

afterAll(async () => {
  await pool.end();
});

describe("user status toggling", () => {
  it("sets status to ACTIVE/INACTIVE when disabling and enabling", async () => {
    const adminPhone = nextPhone();
    await createUserAccount({
      email: "admin-status@apps.com",
      phoneNumber: adminPhone,
      role: ROLES.ADMIN,
    });
    const user = await createUserAccount({
      email: "status-user@apps.com",
      phoneNumber: nextPhone(),
      role: ROLES.STAFF,
    });

    const adminLogin = await otpVerifyRequest(app, {
      phone: adminPhone,
      requestId,
      idempotencyKey: `idem-user-status-${adminPhone}`,
    });

    const disable = await request(app)
      .post(`/api/users/${user.id}/disable`)
      .set("Idempotency-Key", `idem-user-disable-${user.id}`)
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .set("x-request-id", requestId);
    expect(disable.status).toBe(200);

    const disabledRow = await pool.query<{ status: string }>(
      "select status from users where id = $1",
      [user.id]
    );
    expect(disabledRow.rows[0]?.status).toBe("INACTIVE");

    const enable = await request(app)
      .post(`/api/users/${user.id}/enable`)
      .set("Idempotency-Key", `idem-user-enable-${user.id}`)
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .set("x-request-id", requestId);
    expect(enable.status).toBe(200);

    const enabledRow = await pool.query<{ status: string }>(
      "select status from users where id = $1",
      [user.id]
    );
    expect(enabledRow.rows[0]?.status).toBe("ACTIVE");
  });
});
