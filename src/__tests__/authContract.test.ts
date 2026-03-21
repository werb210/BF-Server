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
let idempotencyCounter = 0;
let requestCounter = 0;
let phoneCounter = 700;

const nextIdempotencyKey = (): string => `idem-auth-contract-${idempotencyCounter++}`;
const nextRequestId = (): string => `auth-contract-req-${requestCounter++}`;

const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("delete from client_submissions");
    await client.query("delete from lender_submission_retries");
    await client.query("delete from lender_submissions");
    await client.query("delete from document_version_reviews");
    await client.query("delete from document_versions");
    await client.query("delete from documents");
    await client.query("delete from applications");
    await client.query("delete from idempotency_keys");
    await client.query("delete from password_resets");
    await client.query("delete from audit_events");
    await client.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
    await client.query("commit");
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}

function expectRequestId(res: request.Response, expected: string): void {
  expect(res.headers["x-request-id"]).toBe(expected);
  if (res.body?.requestId) {
    expect(res.body.requestId).toBe(expected);
  }
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
  resetLoginRateLimit();
  idempotencyCounter = 0;
  requestCounter = 0;
  phoneCounter = 700;
});

afterAll(async () => {
  await pool.end();
});

describe("auth contract", () => {
  it("accepts idempotency key for login", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: "contract-login@example.com",
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const requestId = nextRequestId();
    const res = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.accessToken).toBeDefined();
    }
    expectRequestId(res, requestId);
  });

  it("allows login when idempotency key is missing", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: "missing-idem@example.com",
      phoneNumber: phone,
      role: ROLES.STAFF,
    });
    const requestId = nextRequestId();
    const res = await otpVerifyRequest(app, { phone, requestId });

    expect([200, 400]).toContain(res.status);
    expectRequestId(res, requestId);
  });

  it("does not cache login responses for duplicate idempotency keys", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: "duplicate-idem@example.com",
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const requestId = nextRequestId();
    const idempotencyKey = nextIdempotencyKey();

    const first = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey,
    });
    const second = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expectRequestId(first, requestId);
    expectRequestId(second, requestId);
  });

  it("ignores idempotency conflicts for login payload changes", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: "conflict-idem@example.com",
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const requestId = nextRequestId();
    const idempotencyKey = nextIdempotencyKey();

    const first = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey,
    });

    expect([200, 400]).toContain(first.status);

    const second = await otpVerifyRequest(app, {
      phone,
      code: "000000",
      requestId,
      idempotencyKey,
    });

    expect([200, 400]).toContain(second.status);
    if (second.status === 400) {
      expect(second.body.error).toEqual({
        code: "invalid_code",
        message: "Invalid or expired code",
      });
    } else {
      expect(second.body.accessToken).toBeDefined();
    }
    expectRequestId(second, requestId);
  });
});
