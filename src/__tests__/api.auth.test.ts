import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { ROLES } from "../auth/roles";
import { resetLoginRateLimit } from "../middleware/rateLimit";
import { otpVerifyRequest } from "./helpers/otpAuth";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";

const app = buildAppWithApiRoutes();

async function resetDb(): Promise<void> {
  await pool.query("delete from client_submissions");
  await pool.query("delete from lender_submission_retries");
  await pool.query("delete from lender_submissions");
  await pool.query("delete from document_version_reviews");
  await pool.query("delete from document_versions");
  await pool.query("delete from documents");
  await pool.query("delete from applications");
  await pool.query("delete from idempotency_keys");
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

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await pool.end();
});

describe("API auth JSON responses", () => {
  it("returns JSON for /api/auth/otp/start", async () => {
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15878881337" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ sent: true });
    expect(res.text).not.toMatch(/<!doctype|<html/i);
  });

  it("returns JSON error for /api/auth/otp/verify with invalid code", async () => {
    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15878881337", code: "000000" });

    expect([400, 401]).toContain(res.status);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeDefined();
    expect(res.body.requestId).toBeDefined();
    expect(res.text).not.toMatch(/<!doctype|<html/i);
  });

  it("allows OTP verify when user exists via phone column", async () => {
    const phoneNumber = "+14155550001";
    const phone = "+14155550002";
    await insertUser({ phoneNumber, phone });

    const res = await otpVerifyRequest(app, { phone });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.accessToken).toBeTruthy();
    expect(res.text).not.toMatch(/<!doctype|<html/i);
  });

  it("allows OTP verify when user exists via phone_number column", async () => {
    const phone = "+14155550003";
    await insertUser({ phoneNumber: phone, phone: null });

    const res = await otpVerifyRequest(app, { phone });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.accessToken).toBeTruthy();
    expect(res.text).not.toMatch(/<!doctype|<html/i);
  });

  it("rejects OTP verify when disabled = true", async () => {
    const phone = "+14155550004";
    await insertUser({ phoneNumber: phone, disabled: true });

    const res = await otpVerifyRequest(app, { phone });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("account_disabled");
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.text).not.toMatch(/<!doctype|<html/i);
  });

  it("rejects OTP verify when locked_until is in the future", async () => {
    const phone = "+14155550005";
    const lockedUntil = new Date(Date.now() + 5 * 60 * 1000);
    await insertUser({ phoneNumber: phone, lockedUntil });

    const res = await otpVerifyRequest(app, { phone });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("locked");
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.text).not.toMatch(/<!doctype|<html/i);
  });
});
