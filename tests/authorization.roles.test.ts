import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES } from "../src/auth/roles";
import { otpVerifyRequest } from "../src/__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "authz-role-deny";
let phoneCounter = 9400;
const nextPhone = () => `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from pwa_subscriptions");
  await pool.query("delete from pwa_notifications");
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

describe("authorization role enforcement", () => {
  it("denies non-admin access to admin-only endpoints", async () => {
    const staffPhone = nextPhone();
    await createUserAccount({
      email: `staff-${staffPhone}@example.com`,
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const staffLogin = await otpVerifyRequest(app, {
      phone: staffPhone,
      requestId,
      idempotencyKey: `idem-authz-${staffPhone}`,
    });

    const res = await request(app || require("../src/app").default)
      .get("/api/pwa/health")
      .set("Authorization", `Bearer ${staffLogin.body.accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });
});
