import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { resetLoginRateLimit } from "../middleware/rateLimit";
import { ensureAuditEventSchema } from "./helpers/auditSchema";
import { otpVerifyRequest } from "./helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "test-request-id";
let phoneCounter = 100;
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
  process.env.NODE_ENV = "test";
  await ensureAuditEventSchema();
});

beforeEach(async () => {
  await resetDb();
  resetLoginRateLimit();
  phoneCounter = 100;
});

afterAll(async () => {
  await pool.end();
});

describe("auth otp", () => {
  it("verifies otp and returns a jwt token", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: "admin@example.com",
      phoneNumber: phone,
      role: ROLES.ADMIN,
    });

    const res = await otpVerifyRequest(app, {
      phone,
      requestId,
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.headers["set-cookie"]).toBeUndefined();

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.ok).toBe(true);
    expect(me.body.role).toBe(ROLES.ADMIN);
    expect(me.body.silo).toBe("BF");
  });

  it("verifies otp for normalized phone input", async () => {
    const storedPhone = "+1 (587) 888-1837";
    const normalizedPhone = "+15878881837";
    await createUserAccount({
      email: "formatted-phone@example.com",
      phoneNumber: storedPhone,
      role: ROLES.ADMIN,
    });

    const res = await otpVerifyRequest(app, {
      phone: normalizedPhone,
      requestId,
    });

    expect(res.status).toBe(200);
  });

  it("returns 404 for otp verification when phone is unknown", async () => {
    const res = await otpVerifyRequest(app, {
      phone: "+19999999999",
      requestId,
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("user_not_found");
  });

  it("rejects otp verification when code is invalid", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: "bad-code@example.com",
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const res = await otpVerifyRequest(app, {
      phone,
      code: "000000",
      requestId,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: "invalid_code",
      message: "Invalid or expired code",
    });
  });

  it("blocks otp verification for disabled users", async () => {
    const phone = nextPhone();
    const user = await createUserAccount({
      email: "disabled@example.com",
      phoneNumber: phone,
      role: ROLES.STAFF,
    });
    await pool.query(`update users set disabled = true where id = $1`, [user.id]);

    const res = await otpVerifyRequest(app, {
      phone,
      requestId,
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("account_disabled");
  });

});
