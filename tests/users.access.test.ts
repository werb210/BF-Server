import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES } from "../src/auth/roles";
import { ensureAuditEventSchema } from "../src/__tests__/helpers/auditSchema";
import { otpVerifyRequest } from "../src/__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "users-access-test";
let phoneCounter = 8200;
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
  phoneCounter = 8200;
});

afterAll(async () => {
  await pool.end();
});

describe("user access controls", () => {
  it("allows admins to create users and manage roles", async () => {
    const adminPhone = nextPhone();
    await createUserAccount({
      email: `admin-${adminPhone}@example.com`,
      phoneNumber: adminPhone,
      role: ROLES.ADMIN,
    });

    const adminLogin = await otpVerifyRequest(app, {
      phone: adminPhone,
      requestId,
      idempotencyKey: `idem-admin-${adminPhone}`,
    });

    const newUserPhone = nextPhone();
    const create = await request(app || require("../src/app").default)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({
        email: `new-${newUserPhone}@example.com`,
        phoneNumber: newUserPhone,
        role: ROLES.REFERRER,
      });

    expect(create.status).toBe(201);
    expect(create.body.user.role).toBe(ROLES.REFERRER);

    const promote = await request(app || require("../src/app").default)
      .post(`/api/users/${create.body.user.id}/role`)
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({ role: ROLES.STAFF });

    expect(promote.status).toBe(200);

    const disable = await request(app || require("../src/app").default)
      .post(`/api/users/${create.body.user.id}/disable`)
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .set("Idempotency-Key", randomUUID());

    expect(disable.status).toBe(200);

    const enable = await request(app || require("../src/app").default)
      .post(`/api/users/${create.body.user.id}/enable`)
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .set("Idempotency-Key", randomUUID());

    expect(enable.status).toBe(200);
  });

  it("blocks non-admins from creating users or changing roles", async () => {
    const staffPhone = nextPhone();
    await createUserAccount({
      email: `staff-${staffPhone}@example.com`,
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const staffLogin = await otpVerifyRequest(app, {
      phone: staffPhone,
      requestId,
      idempotencyKey: `idem-staff-${staffPhone}`,
    });

    const target = await createUserAccount({
      email: `target-${staffPhone}@example.com`,
      phoneNumber: nextPhone(),
      role: ROLES.REFERRER,
    });

    const create = await request(app || require("../src/app").default)
      .post("/api/users")
      .set("Authorization", `Bearer ${staffLogin.body.accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({
        email: `blocked-${nextPhone()}@example.com`,
        phoneNumber: nextPhone(),
        role: ROLES.LENDER,
      });

    expect(create.status).toBe(403);

    const promote = await request(app || require("../src/app").default)
      .post(`/api/users/${target.id}/role`)
      .set("Authorization", `Bearer ${staffLogin.body.accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({ role: ROLES.ADMIN });

    expect(promote.status).toBe(403);
  });
});
