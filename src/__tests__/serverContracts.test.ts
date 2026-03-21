import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { ensureAuditEventSchema } from "./helpers/auditSchema";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { otpVerifyRequest } from "./helpers/otpAuth";
import { getTwilioMocks } from "./helpers/twilioMocks";
import { markNotReady, markReady } from "../startupState";

const app = buildAppWithApiRoutes();
const requestId = "test-request-id";
let phoneCounter = 500;
const nextPhone = (): string =>
  `+1415666${String(phoneCounter++).padStart(4, "0")}`;
let idempotencyCounter = 0;
const nextIdempotencyKey = (): string => `idem-contract-${idempotencyCounter++}`;

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
  await pool.query("delete from otp_verifications");
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
  phoneCounter = 500;
  idempotencyCounter = 0;
  const twilioMocks = getTwilioMocks();
  twilioMocks.createVerification.mockReset();
  twilioMocks.createVerificationCheck.mockReset();
  twilioMocks.createVerification.mockImplementation(async () => ({
    sid: "VE-DEFAULT",
    status: "pending",
  }));
  twilioMocks.createVerificationCheck.mockImplementation(async (params) => ({
    status: params.code === "123456" ? "approved" : "pending",
    sid: "VE-CHECK-DEFAULT",
  }));
});

afterAll(async () => {
  await pool.end();
});

describe("server boot and health readiness", () => {
  it("serves health even when migrations are pending", async () => {
    markNotReady("pending_migrations");

    const res = await request(app).get("/api/_int/health");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    markReady();
  });
});

describe("otp verification persistence", () => {
  it("creates OTP records, tolerates repeats, and timestamps verified_at", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: "otp-contract@example.com",
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerificationCheck.mockResolvedValueOnce({
      status: "approved",
      sid: "VE-APPROVED-001",
    });

    const first = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    expect(first.status).toBe(200);

    const records = await pool.query(
      `select status, verified_at
       from otp_verifications
       where phone = $1
       order by created_at desc`,
      [phone]
    );
    expect(records.rowCount).toBe(1);
    expect(records.rows[0].status).toBe("approved");
    expect(records.rows[0].verified_at).not.toBeNull();

    twilioMocks.createVerificationCheck.mockRejectedValueOnce(
      new Error("should_not_call_twilio")
    );

    const second = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    expect(second.status).toBe(200);
    expect(second.body.accessToken).toBeTruthy();

    const repeatCount = await pool.query(
      "select count(*)::int as count from otp_verifications where phone = $1",
      [phone]
    );
    expect(repeatCount.rows[0].count).toBe(1);
  });
});

describe("application create contract", () => {
  it("persists raw payload metadata and returns an application id", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: "contract@apps.com",
      phoneNumber: phone,
      role: ROLES.REFERRER,
    });

    const login = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const metadata = {
      raw: {
        businessName: "Raw Payload LLC",
        applicant: { name: "Ava Applicant", email: "ava@applicant.test" },
      },
      matchPercentages: { lenderA: null, lenderB: null },
    };

    const appRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({
        name: "Raw Payload LLC",
        metadata,
        productType: "standard",
      });

    expect(appRes.status).toBe(201);
    expect(appRes.body.application.id).toBeDefined();

    const stored = await pool.query(
      `select name, product_type, metadata
       from applications
       where id = $1`,
      [appRes.body.application.id]
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].name).toBe("Raw Payload LLC");
    expect(stored.rows[0].product_type).toBe("standard");
    expect(stored.rows[0].metadata).toEqual(metadata);
  });
});

describe("document creation on client submission", () => {
  it("creates required document records with default status", async () => {
    const payload = {
      submissionKey: "submission-docs-001",
      productType: "standard",
      business: {
        legalName: "Docs Required LLC",
        taxId: "12-3456789",
        entityType: "llc",
        address: {
          line1: "100 Market St",
          city: "San Francisco",
          state: "CA",
          postalCode: "94105",
          country: "US",
        },
      },
      applicant: {
        firstName: "Ava",
        lastName: "Applicant",
        email: "ava@applicant.test",
        phone: "+1-555-555-0101",
      },
      documents: [
        {
          title: "Bank Statement",
          documentType: "bank_statement",
          metadata: { fileName: "bank.pdf", mimeType: "application/pdf", size: 1234 },
          content: "base64data",
        },
        {
          title: "ID",
          documentType: "id_document",
          metadata: { fileName: "id.pdf", mimeType: "application/pdf", size: 456 },
          content: "base64data2",
        },
      ],
    };

    const res = await request(app)
      .post("/api/client/submissions")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("x-request-id", requestId)
      .send(payload);

    expect(res.status).toBe(201);

    const docs = await pool.query(
      `select document_type, status
       from documents
       where application_id = $1
       order by document_type asc`,
      [res.body.submission.applicationId]
    );
    expect(docs.rowCount).toBe(2);
    expect(docs.rows.map((row) => row.document_type)).toEqual([
      "bank_statement",
      "id_document",
    ]);
    expect(docs.rows.map((row) => row.status)).toEqual([
      "uploaded",
      "uploaded",
    ]);
  });
});

describe("messaging ingress", () => {
  it("returns a messages feed for staff retrieval", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: "messages@apps.com",
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const res = await request(app)
      .get("/api/communications/messages?page=1&pageSize=2")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ messages: [], total: 0 });
    expect(res.body.meta).toEqual({ page: 1, pageSize: 2 });
  });
});

describe("pipeline state transitions", () => {
  it("updates pipeline state with timestamps and keeps latest state authoritative", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: "pipeline@apps.com",
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const appRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({
        name: "Pipeline Contract",
        productType: "standard",
      });
    expect(appRes.status).toBe(201);

    const initial = await pool.query(
      "select pipeline_state, updated_at from applications where id = $1",
      [appRes.body.application.id]
    );
    const initialUpdatedAt = initial.rows[0].updated_at as Date;

    const firstTransition = await request(app)
      .post(`/api/applications/${appRes.body.application.id}/pipeline`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ state: "IN_REVIEW" });
    expect(firstTransition.status).toBe(200);

    const secondTransition = await request(app)
      .post(`/api/applications/${appRes.body.application.id}/pipeline`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ state: "STARTUP" });
    expect(secondTransition.status).toBe(200);

    const thirdTransition = await request(app)
      .post(`/api/applications/${appRes.body.application.id}/pipeline`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ state: "OFF_TO_LENDER" });
    expect(thirdTransition.status).toBe(200);

    const updated = await pool.query(
      "select pipeline_state, updated_at from applications where id = $1",
      [appRes.body.application.id]
    );
    expect(updated.rows[0].pipeline_state).toBe("OFF_TO_LENDER");
    expect((updated.rows[0].updated_at as Date).getTime()).toBeGreaterThan(
      initialUpdatedAt.getTime()
    );
  });
});
