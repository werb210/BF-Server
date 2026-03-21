import { describe, it, expect } from 'vitest';
import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES } from "../src/auth/roles";
import { ensureAuditEventSchema } from "../src/__tests__/helpers/auditSchema";
import { otpVerifyRequest } from "../src/__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "auth-requirements-test";
let phoneCounter = 8000;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from audit_events");
  await pool.query(
    "delete from users where id <> '00000000-0000-0000-0000-000000000001'"
  );
}

beforeAll(async () => {
  process.env.BUILD_TIMESTAMP = "2024-01-01T00:00:00.000Z";
  process.env.COMMIT_SHA = "test-commit";
  process.env.JWT_SECRET = "test-access-secret";
  process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
  process.env.JWT_EXPIRES_IN = "15m";
  process.env.JWT_REFRESH_EXPIRES_IN = "30d";
  process.env.LOGIN_LOCKOUT_THRESHOLD = "2";
  process.env.LOGIN_LOCKOUT_MINUTES = "10";
  process.env.PASSWORD_MAX_AGE_DAYS = "30";
  process.env.NODE_ENV = "test";
  await ensureAuditEventSchema();
});

beforeEach(async () => {
  await resetDb();
  phoneCounter = 8000;
});

afterAll(async () => {
  await pool.end();
});

describe("auth requirements", () => {
  it("returns userId, role, and silo for /api/auth/me", async () => {
    const phone = nextPhone();
    const user = await createUserAccount({
      email: `auth-${phone}@example.com`,
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey: `idem-auth-${phone}`,
    });
    expect(login.status).toBe(200);

    const me = await request(app || require("../src/app").default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.userId).toBe(user.id);
    expect(me.body.role).toBe(ROLES.STAFF);
    expect(me.body.silo).toBe("BF");
  });

  it("refreshes tokens with /api/auth/refresh", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: `refresh-${phone}@example.com`,
      phoneNumber: phone,
      role: ROLES.ADMIN,
    });

    const login = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey: `idem-auth-refresh-${phone}`,
    });

    expect(login.status).toBe(200);
    expect(login.body.refreshToken).toBeTruthy();

    const refresh = await request(app || require("../src/app").default)
      .post("/api/auth/refresh")
      .send({ refreshToken: login.body.refreshToken });

    expect(refresh.status).toBe(200);
    expect(refresh.body.accessToken).toBeTruthy();
    expect(refresh.body.refreshToken).toBeTruthy();
  });

  it("blocks disabled users at auth middleware", async () => {
    const adminPhone = nextPhone();
    const staffPhone = nextPhone();

    await createUserAccount({
      email: `admin-${adminPhone}@example.com`,
      phoneNumber: adminPhone,
      role: ROLES.ADMIN,
    });

    const staffUser = await createUserAccount({
      email: `staff-${staffPhone}@example.com`,
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const adminLogin = await otpVerifyRequest(app, {
      phone: adminPhone,
      requestId,
      idempotencyKey: `idem-admin-${adminPhone}`,
    });

    const staffLogin = await otpVerifyRequest(app, {
      phone: staffPhone,
      requestId,
      idempotencyKey: `idem-staff-${staffPhone}`,
    });

    const disable = await request(app || require("../src/app").default)
      .post(`/api/users/${staffUser.id}/disable`)
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .set("Idempotency-Key", randomUUID());

    expect(disable.status).toBe(200);

    const me = await request(app || require("../src/app").default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${staffLogin.body.accessToken}`);

    expect(me.status).toBe(401);
    expect(me.body.error).toBe("invalid_token");
  });
});
