import { describe, it, expect } from 'vitest';
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { ensureOtpTableExists } from "../db/ensureOtpTable";
import { ROLES } from "../auth/roles";
import { resetLoginRateLimit } from "../middleware/rateLimit";
import { otpVerifyRequest } from "./helpers/otpAuth";
import { seedAdminUser, SEEDED_ADMIN_PHONE } from "../db/seed";

const app = buildAppWithApiRoutes();

async function resetDb(): Promise<void> {
  await ensureOtpTableExists();
  await pool.query("delete from client_submissions");
  await pool.query("delete from lender_submission_retries");
  await pool.query("delete from lender_submissions");
  await pool.query("delete from document_version_reviews");
  await pool.query("delete from document_versions");
  await pool.query("delete from documents");
  await pool.query("delete from applications");
  await pool.query("delete from idempotency_keys");
  try {
    await pool.query("delete from otp_verifications");
  } catch {
  }
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from password_resets");
  await pool.query("delete from audit_events");
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
}

async function insertUser(params: {
  phoneNumber: string;
  phone?: string | null;
  active?: boolean;
  isActive?: boolean | null;
  disabled?: boolean | null;
  lockedUntil?: Date | null;
}): Promise<void> {
  await pool.query(
    `insert into users (id, email, phone_number, phone, role, active, is_active, disabled, locked_until)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      `otp-${randomUUID()}@example.com`,
      params.phoneNumber,
      params.phone ?? null,
      ROLES.STAFF,
      params.active ?? true,
      params.isActive ?? null,
      params.disabled ?? false,
      params.lockedUntil ?? null,
    ]
  );
}

beforeAll(async () => {
  process.env.BUILD_TIMESTAMP = "2024-01-01T00:00:00.000Z";
  process.env.COMMIT_SHA = "test-commit";
  process.env.JWT_SECRET = "test-access-secret";
  process.env.NODE_ENV = "test";
});

beforeEach(async () => {
  await resetDb();
  resetLoginRateLimit();
});

afterAll(async () => {
  await pool.end();
});

describe("API auth otp verify eligibility", () => {
  it("returns user_not_found when no user exists", async () => {
    const phone = "+14155550009";

    const res = await otpVerifyRequest(app, { phone });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("user_not_found");
  });

  it("returns 404 without 500 when otp_verifications is missing", async () => {
    const phone = "+14155550099";
    await pool.query("drop table if exists otp_verifications cascade");

    const res = await otpVerifyRequest(app, { phone });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("user_not_found");
  });

  it("returns 200 for the seeded admin user", async () => {
    await seedAdminUser();

    const res = await otpVerifyRequest(app, { phone: SEEDED_ADMIN_PHONE });

    expect(res.status).toBe(200);
  });

  it("returns 200 when active is true and user is not disabled", async () => {
    const phone = "+14155550010";
    await insertUser({
      phoneNumber: phone,
      active: true,
      isActive: null,
      disabled: false,
      lockedUntil: null,
    });

    const res = await otpVerifyRequest(app, { phone });

    expect(res.status).toBe(200);
  });

  it("returns 200 when is_active is true even if active is false", async () => {
    const phone = "+14155550011";
    await insertUser({
      phoneNumber: phone,
      active: false,
      isActive: true,
      disabled: false,
      lockedUntil: null,
    });

    const res = await otpVerifyRequest(app, { phone });

    expect(res.status).toBe(200);
  });

  it("returns 403 only when disabled is true", async () => {
    const phone = "+14155550012";
    await insertUser({
      phoneNumber: phone,
      active: true,
      isActive: true,
      disabled: true,
      lockedUntil: null,
    });

    const res = await otpVerifyRequest(app, { phone });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("account_disabled");
  });

  it("returns 403 when is_active is false", async () => {
    const phone = "+14155550015";
    await insertUser({
      phoneNumber: phone,
      active: true,
      isActive: false,
      disabled: false,
      lockedUntil: null,
    });

    const res = await otpVerifyRequest(app, { phone });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("user_disabled");
  });

  it("returns 403 when locked_until is in the future", async () => {
    const phone = "+14155550013";
    await insertUser({
      phoneNumber: phone,
      active: true,
      isActive: true,
      disabled: false,
      lockedUntil: new Date(Date.now() + 2 * 60 * 1000),
    });

    const res = await otpVerifyRequest(app, { phone });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("locked");
  });

  it("returns 200 when locked_until is in the past", async () => {
    const phone = "+14155550014";
    await insertUser({
      phoneNumber: phone,
      active: true,
      isActive: true,
      disabled: false,
      lockedUntil: new Date(Date.now() - 2 * 60 * 1000),
    });

    const res = await otpVerifyRequest(app, { phone });

    expect(res.status).toBe(200);
  });
});
