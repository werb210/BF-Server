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
let idempotencyCounter = 0;
const nextIdempotencyKey = (): string => `idem-timeout-${idempotencyCounter++}`;
let phoneCounter = 500;
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
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from password_resets");
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
  idempotencyCounter = 0;
  phoneCounter = 500;
});

afterEach(() => {
  delete process.env.REQUEST_TIMEOUT_MS;
  delete process.env.DB_TEST_SLOW_QUERY_PATTERN;
  delete process.env.DB_TEST_SLOW_QUERY_MS;
});

afterAll(async () => {
  await pool.end();
});

describe("request timeouts", () => {
  it("returns 504 and releases the db connection", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: "timeout@example.com",
      phoneNumber: phone,
      role: ROLES.REFERRER,
    });
    const login = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    process.env.REQUEST_TIMEOUT_MS = "10";
    process.env.DB_TEST_SLOW_QUERY_PATTERN = "insert into applications";
    process.env.DB_TEST_SLOW_QUERY_MS = "40";

    const response = await request(app)
      .post("/api/applications")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .set("Idempotency-Key", nextIdempotencyKey())
      .send({ name: "Timeout App", metadata: { source: "web" }, productType: "standard" });

    expect(response.status).toBe(504);
    expect(response.body.code).toBe("gateway_timeout");
    const ping = await pool.query("select 1 as ok");
    expect(ping.rowCount).toBe(1);
  });
});
