import { describe, it, expect } from 'vitest';
import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { ensureAuditEventSchema } from "./helpers/auditSchema";
import { otpVerifyRequest } from "./helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "test-request-id";
let idempotencyCounter = 0;
const nextIdempotencyKey = (): string => `idem-lender-${idempotencyCounter++}`;
let phoneCounter = 1100;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function seedLenderProduct(submissionMethod: string, email?: string) {
  const lenderId = randomUUID();
  const lenderProductId = randomUUID();
  await pool.query(
    `insert into lenders (id, name, country, submission_method, submission_email, active, status, created_at, updated_at)
     values ($1, $2, $3, $4, $5, true, 'ACTIVE', now(), now())`,
    [lenderId, "Lender Co", "US", submissionMethod, email ?? null]
  );
  await pool.query(
    `insert into lender_products
     (id, lender_id, name, category, country, rate_type, interest_min, interest_max, term_min, term_max, term_unit, active, required_documents, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'MONTHS', $11, $12, now(), now())`,
    [
      lenderProductId,
      lenderId,
      "Standard Product",
      "LOC",
      "US",
      "FIXED",
      "8.5",
      "12.5",
      6,
      24,
      true,
      JSON.stringify([
        { type: "bank_statement", months: 6 },
        { type: "id_document", required: true },
      ]),
    ]
  );
  return { lenderId, lenderProductId };
}

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

async function createApplicationWithDocuments(token: string): Promise<string> {
  const appRes = await request(app)
    .post("/api/applications")
    .set("Idempotency-Key", nextIdempotencyKey())
    .set("Authorization", `Bearer ${token}`)
    .set("x-request-id", requestId)
    .send({ name: "Lender Application", productType: "standard" });

  const applicationId = appRes.body.application.id;

  const bank = await request(app)
    .post(`/api/applications/${applicationId}/documents`)
    .set("Idempotency-Key", nextIdempotencyKey())
    .set("Authorization", `Bearer ${token}`)
    .set("x-request-id", requestId)
    .send({
      title: "Bank Statement",
      documentType: "bank_statement",
      metadata: { fileName: "bank.pdf", mimeType: "application/pdf", size: 123 },
      content: "base64data",
    });
  const idDoc = await request(app)
    .post(`/api/applications/${applicationId}/documents`)
    .set("Idempotency-Key", nextIdempotencyKey())
    .set("Authorization", `Bearer ${token}`)
    .set("x-request-id", requestId)
    .send({
      title: "ID",
      documentType: "id_document",
      metadata: { fileName: "id.pdf", mimeType: "application/pdf", size: 50 },
      content: "iddata",
    });

  await request(app)
    .post(
      `/api/applications/${applicationId}/documents/${bank.body.document.documentId}/versions/${bank.body.document.versionId}/accept`
    )
    .set("Idempotency-Key", nextIdempotencyKey())
    .set("Authorization", `Bearer ${token}`)
    .set("x-request-id", requestId);

  await request(app)
    .post(
      `/api/applications/${applicationId}/documents/${idDoc.body.document.documentId}/versions/${idDoc.body.document.versionId}/accept`
    )
    .set("Idempotency-Key", nextIdempotencyKey())
    .set("Authorization", `Bearer ${token}`)
    .set("x-request-id", requestId);

  return applicationId;
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
  phoneCounter = 1100;
});

afterAll(async () => {
  await pool.end();
});

describe("lender submissions", () => {
  it("prevents duplicate submissions and persists status", async () => {
    const staffPhone = nextPhone();
    await createUserAccount({
      email: "lender@apps.com",
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: staffPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const appRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ name: "Lender Application", productType: "standard" });

    const applicationId = appRes.body.application.id;
    const { lenderId, lenderProductId } = await seedLenderProduct("api");
    await pool.query(
      "update applications set lender_id = $1, lender_product_id = $2 where id = $3",
      [lenderId, lenderProductId, applicationId]
    );

    const bank = await request(app)
      .post(`/api/applications/${applicationId}/documents`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({
        title: "Bank Statement",
        documentType: "bank_statement",
        metadata: { fileName: "bank.pdf", mimeType: "application/pdf", size: 123 },
        content: "base64data",
      });
    const idDoc = await request(app)
      .post(`/api/applications/${applicationId}/documents`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({
        title: "ID",
        documentType: "id_document",
        metadata: { fileName: "id.pdf", mimeType: "application/pdf", size: 50 },
        content: "iddata",
      });

    await request(app)
      .post(
        `/api/applications/${applicationId}/documents/${bank.body.document.documentId}/versions/${bank.body.document.versionId}/accept`
      )
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId);

    await request(app)
      .post(
        `/api/applications/${applicationId}/documents/${idDoc.body.document.documentId}/versions/${idDoc.body.document.versionId}/accept`
      )
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId);

    const idempotencyKey = nextIdempotencyKey();
    const submission1 = await request(app)
      .post("/api/lender/submissions")
      .set("Idempotency-Key", idempotencyKey)
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ applicationId, lenderId, lenderProductId });
    expect(submission1.status).toBe(201);

    const submission2 = await request(app)
      .post("/api/lender/submissions")
      .set("Idempotency-Key", idempotencyKey)
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ applicationId, lenderId, lenderProductId });
    expect(submission2.status).toBe(200);
    expect(submission2.body.submission.id).toBe(submission1.body.submission.id);

    const status = await request(app)
      .get(`/api/lender/submissions/${submission1.body.submission.id}`)
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(status.status).toBe(200);
    expect(status.body.submission.status).toBe("submitted");

    const audit = await pool.query(
      `select event_action as action
       from audit_events
       where event_action in ('lender_submission_created', 'lender_submission_retried')
       order by created_at asc`
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      "lender_submission_created",
      "lender_submission_retried",
    ]);
  });

  it("rejects submissions without required documents", async () => {
    const staffPhone = nextPhone();
    await createUserAccount({
      email: "lender2@apps.com",
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: staffPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const appRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ name: "Blocked Application", productType: "standard" });

    const applicationId = appRes.body.application.id;
    const { lenderId, lenderProductId } = await seedLenderProduct("api");
    await pool.query(
      "update applications set lender_id = $1, lender_product_id = $2 where id = $3",
      [lenderId, lenderProductId, applicationId]
    );

    const submission = await request(app)
      .post("/api/lender/submissions")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ applicationId, lenderId, lenderProductId });

    expect(submission.status).toBe(400);
    expect(submission.body.submission.status).toBe("failed");
    expect(submission.body.submission.failureReason).toBe("missing_documents");
  });

  it("submits applications via email and stores an attachment bundle", async () => {
    const staffPhone = nextPhone();
    await createUserAccount({
      email: "email@apps.com",
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: staffPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const applicationId = await createApplicationWithDocuments(login.body.accessToken);
    const { lenderId, lenderProductId } = await seedLenderProduct("email", "submissions@lender.com");
    await pool.query(
      "update applications set lender_id = $1, lender_product_id = $2 where id = $3",
      [lenderId, lenderProductId, applicationId]
    );

    const submission = await request(app)
      .post("/api/lender/submissions")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ applicationId, lenderId, lenderProductId });

    expect(submission.status).toBe(201);
    expect(submission.body.submission.status).toBe("submitted");

    const stored = await pool.query<{ payload: { attachmentBundle?: unknown[] } }>(
      "select payload from lender_submissions where id = $1",
      [submission.body.submission.id]
    );
    expect(Array.isArray(stored.rows[0]?.payload?.attachmentBundle)).toBe(true);
    expect(stored.rows[0]?.payload?.attachmentBundle?.length).toBe(2);

    const audit = await pool.query<{ count: string }>(
      `select count(*)::int as count
       from audit_events
       where event_action = 'lender_submission_created'
         and target_id = $1`,
      [applicationId]
    );
    expect(Number(audit.rows[0]?.count)).toBeGreaterThan(0);
  });

  it("creates portal submissions without external transmission", async () => {
    const staffPhone = nextPhone();
    await createUserAccount({
      email: "portal@apps.com",
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: staffPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const applicationId = await createApplicationWithDocuments(login.body.accessToken);
    const { lenderId, lenderProductId } = await seedLenderProduct("api");
    await pool.query(
      "update applications set lender_id = $1, lender_product_id = $2 where id = $3",
      [lenderId, lenderProductId, applicationId]
    );

    const submission = await request(app)
      .post("/api/lender/submissions")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ applicationId, lenderId, lenderProductId });

    expect(submission.status).toBe(201);
    expect(submission.body.submission.status).toBe("pending_manual");

    const stored = await pool.query<{ status: string }>(
      "select status from lender_submissions where id = $1",
      [submission.body.submission.id]
    );
    expect(stored.rows[0]?.status).toBe("pending_manual");
  });

  it("fails when lender submission email is missing", async () => {
    const staffPhone = nextPhone();
    await createUserAccount({
      email: "missing@apps.com",
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: staffPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const applicationId = await createApplicationWithDocuments(login.body.accessToken);
    const lenderId = randomUUID();
    const lenderProductId = randomUUID();
    await pool.query(
      `insert into lenders (id, name, country, submission_method, active, status, created_at, updated_at)
       values ($1, $2, $3, 'email', true, 'ACTIVE', now(), now())`,
      [lenderId, "Missing Config Lender", "US"]
    );
    await pool.query(
      `insert into lender_products
       (id, lender_id, name, category, country, rate_type, interest_min, interest_max, term_min, term_max, term_unit, active, required_documents, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'MONTHS', $11, $12, now(), now())`,
      [
        lenderProductId,
        lenderId,
        "Standard Product",
        "LOC",
        "US",
        "FIXED",
        "8.5",
        "12.5",
        6,
        24,
        true,
        JSON.stringify([{ type: "bank_statement", months: 6 }]),
      ]
    );
    await pool.query(
      "update applications set lender_id = $1, lender_product_id = $2 where id = $3",
      [lenderId, lenderProductId, applicationId]
    );

    const submission = await request(app)
      .post("/api/lender/submissions")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ applicationId, lenderId, lenderProductId });

    expect(submission.status).toBe(400);
    expect(submission.body.code).toBe("missing_submission_email");
  });

  it("retries failed lender submissions", async () => {
    const adminPhone = nextPhone();
    await createUserAccount({
      email: "retry@apps.com",
      phoneNumber: adminPhone,
      role: ROLES.ADMIN,
    });

    const login = await otpVerifyRequest(app, {
      phone: adminPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const appRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ name: "Retry Application", productType: "standard" });

    const applicationId = appRes.body.application.id;
    const { lenderId, lenderProductId } = await seedLenderProduct("api");
    await pool.query(
      "update applications set lender_id = $1, lender_product_id = $2, metadata = $3 where id = $4",
      [lenderId, lenderProductId, { forceFailure: true }, applicationId]
    );

    const bank = await request(app)
      .post(`/api/applications/${applicationId}/documents`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({
        title: "Bank Statement",
        documentType: "bank_statement",
        metadata: { fileName: "bank.pdf", mimeType: "application/pdf", size: 123 },
        content: "base64data",
      });
    const idDoc = await request(app)
      .post(`/api/applications/${applicationId}/documents`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({
        title: "ID",
        documentType: "id_document",
        metadata: { fileName: "id.pdf", mimeType: "application/pdf", size: 50 },
        content: "iddata",
      });

    await request(app)
      .post(
        `/api/applications/${applicationId}/documents/${bank.body.document.documentId}/versions/${bank.body.document.versionId}/accept`
      )
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId);

    await request(app)
      .post(
        `/api/applications/${applicationId}/documents/${idDoc.body.document.documentId}/versions/${idDoc.body.document.versionId}/accept`
      )
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId);

    const submission = await request(app)
      .post("/api/lender/submissions")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ applicationId, lenderId, lenderProductId });
    expect(submission.status).toBe(502);
    expect(submission.body.submission.failureReason).toBe("lender_error");

    const retry = await request(app)
      .post(`/api/admin/transmissions/${submission.body.submission.id}/retry`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId);
    expect(retry.status).toBe(200);
    expect(retry.body.retry.status).toBe("submitted");
  });
});
