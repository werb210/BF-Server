import { describe, it, expect } from 'vitest';
import jwt from "jsonwebtoken";
import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { ROLES } from "../auth/roles";
import { resetLoginRateLimit } from "../middleware/rateLimit";
import { ensureAuditEventSchema } from "./helpers/auditSchema";
import { otpVerifyRequest } from "./helpers/otpAuth";
import { getTwilioMocks } from "./helpers/twilioMocks";

const app = buildAppWithApiRoutes();
let phoneCounter = 400;
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
  phoneCounter = 400;
  delete process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL;
  delete process.env.AUTH_BOOTSTRAP_ADMIN_PHONE;
});

afterAll(async () => {
  await pool.end();
});

describe("auth bootstrap admin", () => {
  it("assigns ADMIN role for bootstrap user with null role and issues JWT", async () => {
    const phone = nextPhone();
    process.env.AUTH_BOOTSTRAP_ADMIN_PHONE = phone;

    const userId = randomUUID();
    await pool.query(
      `insert into users (id, email, phone_number, role, active)
       values ($1, $2, $3, $4, $5)`,
      [userId, "bootstrap-admin@example.com", phone, null, true]
    );

    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerificationCheck.mockResolvedValueOnce({
      status: "approved",
      sid: "VE-CHECK-BOOT",
    });

    const res = await otpVerifyRequest(app, { phone });
    expect(res.status).toBe(200);

    const payload = jwt.verify(
      res.body.accessToken,
      process.env.JWT_SECRET ?? "test-access-secret"
    ) as jwt.JwtPayload;

    expect(payload.sub).toBe(userId);
    expect(payload.role).toBe(ROLES.ADMIN);
    expect(payload.silo).toBe("BF");

    const dbRole = await pool.query<{ role: string | null }>(
      `select role from users where id = $1`,
      [userId]
    );
    expect(dbRole.rows[0]?.role).toBe(ROLES.ADMIN);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${res.body.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.ok).toBe(true);
    expect(me.body.role).toBe(ROLES.ADMIN);
    expect(me.body.silo).toBe("BF");
  });
});
