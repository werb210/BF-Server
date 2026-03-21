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
let phoneCounter = 2200;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from lender_products");
  await pool.query("delete from lenders");
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from password_resets");
  await pool.query("delete from audit_events");
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
}

async function loginAdmin(): Promise<string> {
  const phone = nextPhone();
  await createUserAccount({
    email: `portal-idem-${phone}@example.com`,
    phoneNumber: phone,
    role: ROLES.ADMIN,
  });
  const login = await otpVerifyRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-portal-${phone}`,
  });
  return login.body.accessToken as string;
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
  phoneCounter = 2200;
});

afterAll(async () => {
  await pool.end();
});

describe("portal idempotency behavior", () => {
  it("allows POST /api/lenders with auth when Idempotency-Key is missing", async () => {
    const token = await loginAdmin();
    const response = await request(app)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        name: "Portal Lender",
        country: "US",
        phone: "+1-555-0100",
        submissionMethod: "email",
        submissionEmail: "submissions@portal-lender.com",
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
  });

  it("rejects POST /api/lenders without auth when Idempotency-Key is missing", async () => {
    const response = await request(app)
      .post("/api/lenders")
      .set("x-request-id", requestId)
      .send({
        name: "No Auth Lender",
        country: "US",
        phone: "+1-555-0101",
        submissionMethod: "email",
        submissionEmail: "submissions@no-auth-lender.com",
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("missing_idempotency_key");
  });

  it("allows POST /api/lender-products with auth when Idempotency-Key is missing", async () => {
    const token = await loginAdmin();
    const lenderResponse = await request(app)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        name: "Portal Products Lender",
        country: "US",
        phone: "+1-555-0102",
        submissionMethod: "email",
        submissionEmail: "submissions@portal-products-lender.com",
      });

    const response = await request(app)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({ lenderId: lenderResponse.body.id, name: "Portal Product" });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
    expect(response.body.lenderId).toBe(lenderResponse.body.id);
  });

  it("rejects POST /api/lender-products without auth when Idempotency-Key is missing", async () => {
    const response = await request(app)
      .post("/api/lender-products")
      .set("x-request-id", requestId)
      .send({ lenderId: "missing", name: "No Auth Product" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("missing_idempotency_key");
  });
});
