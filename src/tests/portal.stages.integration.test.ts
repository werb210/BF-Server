import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { ensureAuditEventSchema } from "../__tests__/helpers/auditSchema";
import { otpVerifyRequest } from "../__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "portal-stages-test";
let phoneCounter = 7400;
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
  phoneCounter = 7400;
});

afterAll(async () => {
  await pool.end();
});

describe("portal pipeline stages", () => {
  it("returns ordered stages", async () => {
    const staffPhone = nextPhone();
    await createUserAccount({
      email: "portal.stages@apps.com",
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: staffPhone,
      requestId,
      idempotencyKey: `idem-portal-stages-${staffPhone}`,
    });

    const stagesRes = await request(app)
      .get("/api/portal/applications/stages")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(stagesRes.status).toBe(200);
    expect(stagesRes.body).toEqual([
      "RECEIVED",
      "DOCUMENTS_REQUIRED",
      "IN_REVIEW",
      "STARTUP",
      "SENT_TO_LENDER",
      "ACCEPTED",
      "DECLINED",
    ]);
  });
});
