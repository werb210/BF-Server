import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { ensureAuditEventSchema } from "./helpers/auditSchema";

const app = buildAppWithApiRoutes();
const requestId = "test-request-id";
let idempotencyCounter = 0;
const nextIdempotencyKey = (): string => `idem-client-${idempotencyCounter++}`;

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
});

afterAll(async () => {
  await pool.end();
});

describe("client submissions", () => {
  it("accepts a full client submission", async () => {
    const payload = {
      submissionKey: "submission-123",
      productType: "standard",
      business: {
        legalName: "Acme LLC",
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
    expect(res.body.submission.applicationId).toBeDefined();
    expect(res.body.submission.pipelineState).toBe("DOCUMENTS_REQUIRED");

    const appRes = await pool.query(
      "select pipeline_state from applications where id = $1",
      [res.body.submission.applicationId]
    );
    expect(appRes.rows[0].pipeline_state).toBe("DOCUMENTS_REQUIRED");

    const docRes = await pool.query(
      "select count(*)::int as count from documents where application_id = $1",
      [res.body.submission.applicationId]
    );
    expect(docRes.rows[0].count).toBe(2);
  });

  it("rejects invalid submissions", async () => {
    const payload = {
      submissionKey: "submission-456",
      productType: "standard",
      business: {
        legalName: "Acme LLC",
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
      ],
    };

    const res = await request(app)
      .post("/api/client/submissions")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("x-request-id", requestId)
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("missing_documents");
  });
});
