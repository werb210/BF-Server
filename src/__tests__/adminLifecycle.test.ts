import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { ensureAuditEventSchema } from "./helpers/auditSchema";
import { otpVerifyRequest } from "./helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "test-request-id";
let idempotencyCounter = 0;
const nextIdempotencyKey = (): string => `idem-admin-${idempotencyCounter++}`;
let phoneCounter = 200;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from client_submissions");
  await pool.query("delete from lender_submission_retries");
  await pool.query("delete from lender_submissions");
  await pool.query("delete from document_version_reviews");
  await pool.query("delete from document_versions");
  await pool.query("delete from documents");
  await pool.query("delete from applications");
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from password_resets");
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
  idempotencyCounter = 0;
  phoneCounter = 200;
});

afterAll(async () => {
  await pool.end();
});

describe("admin lifecycle", () => {
  it("enforces admin-only access for user management", async () => {
    const staffPhone = nextPhone();
    await createUserAccount({
      email: "staff@example.com",
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });
    const staffLogin = await otpVerifyRequest(app, {
      phone: staffPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const res = await request(app)
      .post("/api/users")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${staffLogin.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({
        email: "new@example.com",
        phoneNumber: nextPhone(),
        role: ROLES.REFERRER,
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("blocks new OTP logins after disable", async () => {
    const adminPhone = nextPhone();
    const userPhone = nextPhone();
    await createUserAccount({
      email: "admin@example.com",
      phoneNumber: adminPhone,
      role: ROLES.ADMIN,
    });
    const user = await createUserAccount({
      email: "user@example.com",
      phoneNumber: userPhone,
      role: ROLES.STAFF,
    });

    const adminLogin = await otpVerifyRequest(app, {
      phone: adminPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });
    const userLogin = await otpVerifyRequest(app, {
      phone: userPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const disable = await request(app)
      .post(`/api/users/${user.id}/disable`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .set("x-request-id", requestId);
    expect(disable.status).toBe(200);

    const deniedLogin = await otpVerifyRequest(app, {
      phone: userPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });
    expect(deniedLogin.status).toBe(403);
    expect(deniedLogin.body.code).toBe("user_disabled");

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${userLogin.body.accessToken}`);
    expect(me.status).toBe(403);
    expect(me.body.error).toBe("user_disabled");
  });

  it("records audit events for lifecycle actions", async () => {
    const adminPhone = nextPhone();
    await createUserAccount({
      email: "admin-audit@example.com",
      phoneNumber: adminPhone,
      role: ROLES.ADMIN,
    });
    const adminLogin = await otpVerifyRequest(app, {
      phone: adminPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const created = await request(app)
      .post("/api/users")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({
        email: "audited@example.com",
        phoneNumber: nextPhone(),
        role: ROLES.STAFF,
      });
    expect(created.status).toBe(201);
    const userId = created.body.user.id;

    const disable = await request(app)
      .post(`/api/users/${userId}/disable`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .set("x-request-id", requestId);
    expect(disable.status).toBe(200);

    const enable = await request(app)
      .post(`/api/users/${userId}/enable`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .set("x-request-id", requestId);
    expect(enable.status).toBe(200);

    const roleChange = await request(app)
      .post(`/api/users/${userId}/role`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ role: ROLES.ADMIN });
    expect(roleChange.status).toBe(200);

    const audit = await pool.query(
      `select event_action as action
       from audit_events
       where target_user_id = $1
         and event_action in ('user_created', 'user_disabled', 'user_enabled', 'user_role_changed')
       order by created_at asc`,
      [userId]
    );

    expect(audit.rows.map((row) => row.action)).toEqual([
      "user_created",
      "user_disabled",
      "user_enabled",
      "user_role_changed",
    ]);
  });

  it("updates user status to ACTIVE/INACTIVE when toggling", async () => {
    const adminPhone = nextPhone();
    await createUserAccount({
      email: "admin-status@example.com",
      phoneNumber: adminPhone,
      role: ROLES.ADMIN,
    });
    const user = await createUserAccount({
      email: "status-user@example.com",
      phoneNumber: nextPhone(),
      role: ROLES.STAFF,
    });

    const adminLogin = await otpVerifyRequest(app, {
      phone: adminPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const disable = await request(app)
      .post(`/api/users/${user.id}/disable`)
      .set("Idempotency-Key", nextIdempotencyKey())
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
      .set("Idempotency-Key", nextIdempotencyKey())
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
