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
const nextIdempotencyKey = (): string => `idem-app-${idempotencyCounter++}`;
let phoneCounter = 300;
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
  phoneCounter = 300;
});

afterAll(async () => {
  await pool.end();
});

describe("applications and documents", () => {
  it("creates applications and versions documents", async () => {
    const userPhone = nextPhone();
    await createUserAccount({
      email: "user@apps.com",
      phoneNumber: userPhone,
      role: ROLES.REFERRER,
    });

    const login = await otpVerifyRequest(app, {
      phone: userPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const appRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({
        name: "Test Application",
        metadata: { source: "web" },
        productType: "standard",
      });
    expect(appRes.status).toBe(201);

    const applicationId = appRes.body.application.id;

    const upload1 = await request(app)
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
    expect(upload1.status).toBe(201);
    expect(upload1.body.document.version).toBe(1);

    const upload2 = await request(app)
      .post(`/api/applications/${applicationId}/documents`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({
        documentId: upload1.body.document.documentId,
        title: "Bank Statement",
        documentType: "bank_statement",
        metadata: { fileName: "bank-v2.pdf", mimeType: "application/pdf", size: 456 },
        content: "base64data2",
      });
    expect(upload2.status).toBe(201);
    expect(upload2.body.document.version).toBe(2);
  });

  it("enforces application ownership for document uploads", async () => {
    const ownerPhone = nextPhone();
    const otherPhone = nextPhone();
    await createUserAccount({
      email: "owner@apps.com",
      phoneNumber: ownerPhone,
      role: ROLES.REFERRER,
    });
    await createUserAccount({
      email: "other@apps.com",
      phoneNumber: otherPhone,
      role: ROLES.REFERRER,
    });

    const ownerLogin = await otpVerifyRequest(app, {
      phone: ownerPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });
    const otherLogin = await otpVerifyRequest(app, {
      phone: otherPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const appRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${ownerLogin.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ name: "Owner Application", productType: "standard" });
    expect(appRes.status).toBe(201);

    const upload = await request(app)
      .post(`/api/applications/${appRes.body.application.id}/documents`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${otherLogin.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({
        title: "Unauthorized",
        documentType: "bank_statement",
        metadata: { fileName: "oops.pdf", mimeType: "application/pdf", size: 12 },
        content: "data",
      });
    expect(upload.status).toBe(403);
    expect(upload.body.code).toBe("forbidden");
  });

  it("rejects invalid pipeline transitions without override", async () => {
    const staffPhone = nextPhone();
    await createUserAccount({
      email: "staff@apps.com",
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
      .send({ name: "Pipeline Application", productType: "standard" });

    const transition = await request(app)
      .post(`/api/applications/${appRes.body.application.id}/pipeline`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ state: "OFF_TO_LENDER" });

    expect(transition.status).toBe(400);
    expect(transition.body.code).toBe("invalid_transition");
  });

  it("allows override pipeline transitions", async () => {
    const overridePhone = nextPhone();
    await createUserAccount({
      email: "override@apps.com",
      phoneNumber: overridePhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: overridePhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const appRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ name: "Override Application", productType: "standard" });

    const applicationId = appRes.body.application.id;

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

    const transition = await request(app)
      .post(`/api/applications/${applicationId}/pipeline`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ state: "OFF_TO_LENDER", override: true });

    expect(transition.status).toBe(200);

    const dbState = await pool.query(
      "select pipeline_state from applications where id = $1",
      [applicationId]
    );
    expect(dbState.rows[0].pipeline_state).toBe("OFF_TO_LENDER");
  });

  it("forces requires docs when documents are missing", async () => {
    const requirementsPhone = nextPhone();
    await createUserAccount({
      email: "requirements@apps.com",
      phoneNumber: requirementsPhone,
      role: ROLES.REFERRER,
    });

    const login = await otpVerifyRequest(app, {
      phone: requirementsPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const appRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ name: "Requirement App", productType: "standard" });
    expect(appRes.status).toBe(201);
    expect(appRes.body.application.pipelineState).toBe("DOCUMENTS_REQUIRED");
  });

  it("transitions to under review when required documents are accepted", async () => {
    const acceptPhone = nextPhone();
    await createUserAccount({
      email: "accept@apps.com",
      phoneNumber: acceptPhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: acceptPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const appRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ name: "Acceptance App", productType: "standard" });

    const applicationId = appRes.body.application.id;

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

    const stateAfterAccept = await pool.query(
      "select pipeline_state from applications where id = $1",
      [applicationId]
    );
    expect(stateAfterAccept.rows[0].pipeline_state).toBe("IN_REVIEW");

    const audit = await pool.query(
      `select event_action as action
       from audit_events
       where event_action = 'document_accepted'
       order by created_at asc`
    );
    expect(audit.rows.length).toBe(2);
  });

  it("forces requires docs on document rejection", async () => {
    const reviewPhone = nextPhone();
    await createUserAccount({
      email: "review@apps.com",
      phoneNumber: reviewPhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: reviewPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const appRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ name: "Review App", productType: "standard" });

    const applicationId = appRes.body.application.id;

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
    expect(bank.status).toBe(201);

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
    expect(idDoc.status).toBe(201);

    const reject = await request(app)
      .post(
        `/api/applications/${applicationId}/documents/${bank.body.document.documentId}/versions/${bank.body.document.versionId}/reject`
      )
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId);
    expect(reject.status).toBe(200);

    const stateAfterReject = await pool.query(
      "select pipeline_state from applications where id = $1",
      [applicationId]
    );
    expect(stateAfterReject.rows[0].pipeline_state).toBe("DOCUMENTS_REQUIRED");
  });

  it("rejects documents with invalid mime types", async () => {
    const invalidPhone = nextPhone();
    await createUserAccount({
      email: "invalidmime@apps.com",
      phoneNumber: invalidPhone,
      role: ROLES.REFERRER,
    });

    const login = await otpVerifyRequest(app, {
      phone: invalidPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const appRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ name: "Mime App", productType: "standard" });

    const upload = await request(app)
      .post(`/api/applications/${appRes.body.application.id}/documents`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({
        title: "Invalid",
        documentType: "bank_statement",
        metadata: { fileName: "bad.txt", mimeType: "text/plain", size: 12 },
        content: "data",
      });
    expect(upload.status).toBe(400);
    expect(upload.body.code).toBe("invalid_mime_type");

    const audit = await pool.query(
      `select event_action as action
       from audit_events
       where event_action = 'document_upload_rejected'`
    );
    expect(audit.rows.length).toBe(1);
  });

  it("persists applications through all pipeline stages", async () => {
    const stagePhone = nextPhone();
    await createUserAccount({
      email: "stages@apps.com",
      phoneNumber: stagePhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: stagePhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const appRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ name: "Stage App", productType: "standard" });

    const applicationId = appRes.body.application.id;

    await pool.query(
      "update applications set pipeline_state = 'RECEIVED' where id = $1",
      [applicationId]
    );
    const receivedState = await pool.query(
      "select pipeline_state from applications where id = $1",
      [applicationId]
    );
    expect(receivedState.rows[0].pipeline_state).toBe("RECEIVED");

    const stageSequence = [
      "DOCUMENTS_REQUIRED",
      "IN_REVIEW",
      "STARTUP",
      "OFF_TO_LENDER",
      "ACCEPTED",
    ];

    for (const stage of stageSequence) {
      const transition = await request(app)
        .post(`/api/applications/${applicationId}/pipeline`)
        .set("Idempotency-Key", nextIdempotencyKey())
        .set("Authorization", `Bearer ${login.body.accessToken}`)
        .set("x-request-id", requestId)
        .send({ state: stage });
      expect(transition.status).toBe(200);

      const current = await pool.query(
        "select pipeline_state from applications where id = $1",
        [applicationId]
      );
      expect(current.rows[0].pipeline_state).toBe(stage);
    }

    const declineRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ name: "Decline App", productType: "standard" });

    const declinedId = declineRes.body.application.id;
    await pool.query(
      "update applications set pipeline_state = 'IN_REVIEW' where id = $1",
      [declinedId]
    );

    const declineTransition = await request(app)
      .post(`/api/applications/${declinedId}/pipeline`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ state: "DECLINED" });

    expect(declineTransition.status).toBe(200);
    const declinedState = await pool.query(
      "select pipeline_state from applications where id = $1",
      [declinedId]
    );
    expect(declinedState.rows[0].pipeline_state).toBe("DECLINED");
  });
});
