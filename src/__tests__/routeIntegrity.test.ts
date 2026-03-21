import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { ROLES, type Role } from "../auth/roles";
import { ROUTES, type ApiRoute } from "../routes/routeRegistry";
import { createUserAccount } from "../modules/auth/auth.service";
import { seedAdminUser, SEEDED_ADMIN_PHONE } from "../db/seed";
import { ensureAuditEventSchema } from "./helpers/auditSchema";
import { otpStartRequest, otpVerifyRequest } from "./helpers/otpAuth";
import { randomUUID } from "crypto";

const app = buildAppWithApiRoutes();

const rolePhones: Record<Role, string> = {
  [ROLES.ADMIN]: SEEDED_ADMIN_PHONE,
  [ROLES.STAFF]: "+15555550100",
  [ROLES.OPS]: "+15555550103",
  [ROLES.LENDER]: "+15555550101",
  [ROLES.REFERRER]: "+15555550102",
};

async function resetDb(): Promise<void> {
  await pool.query("delete from client_submissions");
  await pool.query("delete from lender_submission_retries");
  await pool.query("delete from lender_submissions");
  await pool.query("delete from document_version_reviews");
  await pool.query("delete from document_versions");
  await pool.query("delete from documents");
  await pool.query("delete from applications");
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from password_resets");
  await pool.query("delete from audit_events");
  await pool.query("delete from users");
}

async function loginWithOtp(phone: string): Promise<string> {
  const start = await otpStartRequest(app, { phone });
  expect(start.status).toBe(200);

  const verify = await otpVerifyRequest(app, { phone });
  expect(verify.status).toBe(200);
  return verify.body.accessToken as string;
}

async function setupRoleUsers(): Promise<void> {
  await seedAdminUser();
  await createUserAccount({
    phoneNumber: rolePhones[ROLES.STAFF],
    role: ROLES.STAFF,
  });
  const lenderId = randomUUID();
  await pool.query(
    `insert into lenders (id, name, country, submission_method, active, status, created_at, updated_at)
     values ($1, $2, $3, 'email', true, 'ACTIVE', now(), now())`,
    [lenderId, "Integrity Lender", "US"]
  );
  await createUserAccount({
    phoneNumber: rolePhones[ROLES.OPS],
    role: ROLES.OPS,
  });
  await createUserAccount({
    phoneNumber: rolePhones[ROLES.LENDER],
    role: ROLES.LENDER,
    lenderId,
  });
  await createUserAccount({
    phoneNumber: rolePhones[ROLES.REFERRER],
    role: ROLES.REFERRER,
  });
}

function requestRoute(route: ApiRoute, token: string) {
  const method = route.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
  return request(app)[method](route.path).set("Authorization", `Bearer ${token}`);
}

beforeAll(async () => {
  process.env.JWT_SECRET = "test-access-secret";
  process.env.NODE_ENV = "test";
  await ensureAuditEventSchema();
});

beforeEach(async () => {
  await resetDb();
  await setupRoleUsers();
});

afterAll(async () => {
  await pool.end();
});

describe("route integrity", () => {
  it("verifies registry routes are mounted and responsive", async () => {
    const adminToken = await loginWithOtp(rolePhones[ROLES.ADMIN]);
    for (const route of ROUTES) {
      const res = await requestRoute(route, adminToken);
      expect(res.status).not.toBe(404);
      expect(res.status).not.toBe(500);
    }
  });

  it("enforces RBAC for registry routes", async () => {
    const tokens = new Map<Role, string>();
    for (const role of Object.values(ROLES)) {
      const token = await loginWithOtp(rolePhones[role]);
      tokens.set(role, token);
    }

    for (const route of ROUTES) {
      for (const role of Object.values(ROLES)) {
        const token = tokens.get(role);
        if (!token) {
          throw new Error(`Missing token for role ${role}`);
        }
        const res = await requestRoute(route, token);
        if (route.roles.includes(role)) {
          if (res.status === 403) {
            throw new Error(`Expected ${role} access to ${route.method} ${route.path}`);
          }
        } else {
          expect(res.status).toBe(403);
        }
      }
    }
  });

  it("maintains auth across protected navigation calls", async () => {
    const adminToken = await loginWithOtp(rolePhones[ROLES.ADMIN]);

    const applications = await request(app)
      .get("/api/applications")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(applications.status).toBe(200);

    const dashboard = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(dashboard.status).toBe(200);

    const applicationsAgain = await request(app)
      .get("/api/applications")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(applicationsAgain.status).toBe(200);
  });
});
