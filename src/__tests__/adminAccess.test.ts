import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { ROLES, normalizeRole } from "../auth/roles";
import {
  seedAdminUser,
  seedSecondAdminUser,
  SEEDED_ADMIN2_PHONE,
  SEEDED_ADMIN_PHONE,
} from "../db/seed";
import { ensureAuditEventSchema } from "./helpers/auditSchema";
import { otpStartRequest, otpVerifyRequest } from "./helpers/otpAuth";

const app = buildAppWithApiRoutes();
let idempotencyCounter = 0;
const nextIdempotencyKey = (): string => `admin-access-${idempotencyCounter++}`;

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

async function loginWithOtp(phone: string): Promise<string> {
  const start = await otpStartRequest(app, { phone });
  expect(start.status).toBe(200);

  const verify = await otpVerifyRequest(app, { phone });
  expect(verify.status).toBe(200);
  expect(verify.body.accessToken).toBeTruthy();
  return verify.body.accessToken as string;
}

beforeAll(async () => {
  process.env.JWT_SECRET = "test-access-secret";
  process.env.NODE_ENV = "test";
  await ensureAuditEventSchema();
});

beforeEach(async () => {
  await resetDb();
  idempotencyCounter = 0;
  await seedAdminUser();
});

afterAll(async () => {
  await pool.end();
});

describe("admin access coverage", () => {
  it("completes OTP auth flow and returns Admin role from /api/auth/me", async () => {
    const token = await loginWithOtp(SEEDED_ADMIN_PHONE);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(me.status).toBe(200);
    expect(me.body.ok).toBe(true);
    expect(me.body.role).toBe(ROLES.ADMIN);
    expect(me.body.silo).toBe("BF");
  });

  it("allows Admin to access all protected module routes", async () => {
    const token = await loginWithOtp(SEEDED_ADMIN_PHONE);

    const routes = [
      "/api/applications",
      "/api/crm",
      "/api/crm/customers",
      "/api/communications",
      "/api/communications/messages",
      "/api/calendar",
      "/api/calendar/tasks",
      "/api/tasks",
      "/api/marketing",
      "/api/marketing/campaigns",
      "/api/lenders",
      "/api/settings",
      "/api/settings/preferences",
      "/api/staff/overview",
      "/api/dashboard",
    ];

    for (const path of routes) {
      const res = await request(app)
        .get(path)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    }
  });

  it("maintains auth across Dashboard → Applications → Dashboard navigation", async () => {
    const token = await loginWithOtp(SEEDED_ADMIN_PHONE);

    const dashboardStart = await request(app)
      .get("/api/staff/overview")
      .set("Authorization", `Bearer ${token}`);
    expect(dashboardStart.status).toBe(200);

    const applications = await request(app)
      .get("/api/applications")
      .set("Authorization", `Bearer ${token}`);
    expect(applications.status).toBe(200);

    const dashboardReturn = await request(app)
      .get("/api/staff/overview")
      .set("Authorization", `Bearer ${token}`);
    expect(dashboardReturn.status).toBe(200);
  });

  it("rejects role mismatches like Administrator", async () => {
    expect(normalizeRole("Administrator")).toBeNull();

    const token = await loginWithOtp(SEEDED_ADMIN_PHONE);
    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("x-request-id", `admin-access-${idempotencyCounter}`)
      .send({ email: "bad-role@example.com", phoneNumber: "+14155550123", role: "Administrator" });

    expect(res.status).toBe(400);
    const contentType = res.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(
        `Unexpected response ${res.status} ${contentType}: ${res.text}`
      );
    }
    const payload = res.body as { code?: string };
    expect(payload.code).toBe("invalid_role");
  });

  it("seeds a second Admin user that can authenticate", async () => {
    await seedSecondAdminUser();
    const token = await loginWithOtp(SEEDED_ADMIN2_PHONE);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(me.status).toBe(200);
    expect(me.body.ok).toBe(true);
    expect(me.body.role).toBe(ROLES.ADMIN);
    expect(me.body.silo).toBe("BF");
  });
});
