import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../../src/app";
import { pool } from "../../src/db";
import { createUserAccount } from "../../src/modules/auth/auth.service";
import { ROLES } from "../../src/auth/roles";
import { ensureAuditEventSchema } from "../../src/__tests__/helpers/auditSchema";
import { otpVerifyRequest } from "../../src/__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "auth-logout-test";
let phoneCounter = 9000;

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
  phoneCounter = 9000;
});

afterAll(async () => {
  await pool.end();
});

describe("auth logout", () => {
  it("invalidates access tokens after logout", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: `logout-${phone}@example.com`,
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey: `idem-auth-logout-${phone}`,
    });
    expect(login.status).toBe(200);
    expect(login.body.refreshToken).toBeTruthy();

    const me = await request(app || require("../src/app").default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200);

    const logout = await request(app || require("../src/app").default)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(logout.status).toBe(200);
    expect(logout.body.ok).toBe(true);

    const refresh = await request(app || require("../src/app").default)
      .post("/api/auth/refresh")
      .send({ refreshToken: login.body.refreshToken });
    expect(refresh.status).toBe(401);
    expect(refresh.body.error.code).toBe("invalid_refresh_token");

    const meAfterLogout = await request(app || require("../src/app").default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(meAfterLogout.status).toBe(401);
    expect(meAfterLogout.body.error).toBe("invalid_token");
  });
});
