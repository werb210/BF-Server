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
const nextIdempotencyKey = (): string => `idem-guard-${idempotencyCounter++}`;
let phoneCounter = 800;
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
  await pool.query("delete from otp_verifications");
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
  phoneCounter = 800;
});

afterAll(async () => {
  await pool.end();
});

describe("concurrency guardrails", () => {
  it("allows only one of concurrent accept/reject to succeed", async () => {
    const reviewerPhone = nextPhone();
    await createUserAccount({
      email: "reviewer@example.com",
      phoneNumber: reviewerPhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: reviewerPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const application = await request(app)
      .post("/api/applications")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .set("Idempotency-Key", nextIdempotencyKey())
      .send({ name: "Guard App", metadata: { source: "web" }, productType: "standard" });

    const upload = await request(app)
      .post(`/api/applications/${application.body.application.id}/documents`)
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .set("Idempotency-Key", nextIdempotencyKey())
      .send({
        title: "Bank Statement",
        documentType: "bank_statement",
        metadata: { fileName: "bank.pdf", mimeType: "application/pdf", size: 123 },
        content: "base64data",
      });

    const { documentId, versionId } = upload.body.document;
    const [acceptRes, rejectRes] = await Promise.all([
      request(app)
        .post(
          `/api/applications/${application.body.application.id}/documents/${documentId}/versions/${versionId}/accept`
        )
        .set("Authorization", `Bearer ${login.body.accessToken}`)
        .set("x-request-id", requestId)
        .set("Idempotency-Key", nextIdempotencyKey()),
      request(app)
        .post(
          `/api/applications/${application.body.application.id}/documents/${documentId}/versions/${versionId}/reject`
        )
        .set("Authorization", `Bearer ${login.body.accessToken}`)
        .set("x-request-id", requestId)
        .set("Idempotency-Key", nextIdempotencyKey()),
    ]);

    const statuses = [acceptRes.status, rejectRes.status].sort();
    expect(statuses).toEqual([200, 409]);
    const reviews = await pool.query("select count(*)::int as count from document_version_reviews");
    expect(reviews.rows[0].count).toBe(1);
  });
});
