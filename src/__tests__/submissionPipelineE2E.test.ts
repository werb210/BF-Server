import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import {
  clearDbTestFailureInjection,
  pool,
  setDbTestFailureInjection,
  setDbTestPoolMetricsOverride,
} from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { ensureAuditEventSchema } from "./helpers/auditSchema";
import { otpVerifyRequest } from "./helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "test-request-id";
let idempotencyCounter = 0;
const nextIdempotencyKey = (): string => `idem-e2e-${idempotencyCounter++}`;
const nextRequestId = (): string => `req-e2e-${idempotencyCounter++}`;
let phoneCounter = 600;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;
const defaultLenderId = "00000000-0000-0000-0000-00000000a001";
const defaultLenderProductId = "00000000-0000-0000-0000-00000000b001";

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

type AuthContext = {
  token: string;
  userId: string;
};

type UploadResponse = {
  documentId: string;
  versionId: string;
};

async function loginAsStaff(): Promise<AuthContext> {
  const staffPhone = nextPhone();
  const user = await createUserAccount({
    email: "staff@example.com",
    phoneNumber: staffPhone,
    role: ROLES.STAFF,
  });

  const res = await otpVerifyRequest(app, {
    phone: staffPhone,
    requestId,
    idempotencyKey: nextIdempotencyKey(),
  });

  expect(res.status).toBe(200);

  return {
    token: res.body.accessToken,
    userId: user.id,
  };
}

async function createApplication(token: string): Promise<string> {
  const res = await request(app)
    .post("/api/applications")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", nextIdempotencyKey())
    .set("x-request-id", nextRequestId())
    .send({ name: "Acme Application", productType: "standard", metadata: { source: "e2e" } });

  expect(res.status).toBe(201);
  await pool.query(
    "update applications set lender_id = $1, lender_product_id = $2 where id = $3",
    [defaultLenderId, defaultLenderProductId, res.body.application.id]
  );
  return res.body.application.id;
}

async function uploadDocument(
  token: string,
  applicationId: string,
  documentType: string,
  title: string
): Promise<UploadResponse> {
  const upload = await request(app)
    .post(`/api/applications/${applicationId}/documents`)
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", nextIdempotencyKey())
    .set("x-request-id", nextRequestId())
    .send({
      title,
      documentType,
      metadata: {
        fileName: `${documentType}.pdf`,
        mimeType: "application/pdf",
        size: 2048,
      },
      content: "base64data",
    });

  expect(upload.status).toBe(201);
  return upload.body.document;
}

async function acceptDocument(
  token: string,
  applicationId: string,
  document: UploadResponse
): Promise<void> {
  const res = await request(app)
    .post(
      `/api/applications/${applicationId}/documents/${document.documentId}/versions/${document.versionId}/accept`
    )
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", nextIdempotencyKey())
    .set("x-request-id", nextRequestId());

  expect(res.status).toBe(200);
}

async function submitToLender(
  token: string,
  applicationId: string,
  lenderId = defaultLenderId,
  lenderProductId = defaultLenderProductId,
  idempotencyKey?: string
): Promise<request.Response> {
  return request(app)
    .post("/api/lender/submissions")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", idempotencyKey ?? nextIdempotencyKey())
    .set("x-request-id", nextRequestId())
    .send({ applicationId, lenderId, lenderProductId });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
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
  idempotencyCounter = 0;
  phoneCounter = 600;
  clearDbTestFailureInjection();
  setDbTestPoolMetricsOverride(null);
});

afterAll(async () => {
  await pool.end();
});

describe("submission pipeline end-to-end", () => {
  it("completes a full submission without warnings or retries", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { token } = await loginAsStaff();
      const applicationId = await createApplication(token);

      const createdState = await pool.query<{ pipeline_state: string }>(
        "select pipeline_state from applications where id = $1",
        [applicationId]
      );
      expect(createdState.rows[0]?.pipeline_state).toBe("DOCUMENTS_REQUIRED");

      const bank = await uploadDocument(token, applicationId, "bank_statement", "Bank Statement");
      const idDoc = await uploadDocument(token, applicationId, "id_document", "ID Document");

      await acceptDocument(token, applicationId, bank);
      await acceptDocument(token, applicationId, idDoc);

      const reviewState = await pool.query<{ pipeline_state: string }>(
        "select pipeline_state from applications where id = $1",
        [applicationId]
      );
      expect(reviewState.rows[0]?.pipeline_state).toBe("IN_REVIEW");

      const submission = await submitToLender(token, applicationId);

      expect(submission.status).toBe(201);
      expect(submission.body.submission.status).toBe("submitted");

      const finalState = await pool.query<{ pipeline_state: string }>(
        "select pipeline_state from applications where id = $1",
        [applicationId]
      );
      expect(finalState.rows[0]?.pipeline_state).toBe("OFF_TO_LENDER");

      const [applications, documents, versions, reviews, submissions, retries] = await Promise.all([
        pool.query("select count(*)::int as count from applications where id = $1", [applicationId]),
        pool.query("select count(*)::int as count from documents where application_id = $1", [
          applicationId,
        ]),
        pool.query(
          `select count(*)::int as count
           from document_versions dv
           join documents d on d.id = dv.document_id
           where d.application_id = $1`,
          [applicationId]
        ),
        pool.query(
          `select count(*)::int as count
           from document_version_reviews r
           join document_versions dv on dv.id = r.document_version_id
           join documents d on d.id = dv.document_id
           where d.application_id = $1
             and r.status = 'accepted'`,
          [applicationId]
        ),
        pool.query(
          "select count(*)::int as count from lender_submissions where application_id = $1",
          [applicationId]
        ),
        pool.query("select count(*)::int as count from lender_submission_retries"),
      ]);

      expect(applications.rows[0]?.count).toBe(1);
      expect(documents.rows[0]?.count).toBe(2);
      expect(versions.rows[0]?.count).toBe(2);
      expect(reviews.rows[0]?.count).toBe(2);
      expect(submissions.rows[0]?.count).toBe(1);
      expect(retries.rows[0]?.count).toBe(0);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("rolls back document uploads that fail mid-transaction", async () => {
    const { token } = await loginAsStaff();
    const applicationId = await createApplication(token);

    setDbTestFailureInjection({
      mode: "connection_reset",
      remaining: 1,
      matchQuery: "insert into document_versions",
    });

    const failed = await request(app)
      .post(`/api/applications/${applicationId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("x-request-id", nextRequestId())
      .send({
        title: "Bank Statement",
        documentType: "bank_statement",
        metadata: {
          fileName: "bank.pdf",
          mimeType: "application/pdf",
          size: 2048,
        },
        content: "base64data",
      });

    expect(failed.status).toBe(503);

    const [documents, versions, appState] = await Promise.all([
      pool.query("select count(*)::int as count from documents where application_id = $1", [
        applicationId,
      ]),
      pool.query(
        `select count(*)::int as count
         from document_versions dv
         join documents d on d.id = dv.document_id
         where d.application_id = $1`,
        [applicationId]
      ),
      pool.query<{ pipeline_state: string }>(
        "select pipeline_state from applications where id = $1",
        [applicationId]
      ),
    ]);

    expect(documents.rows[0]?.count).toBe(0);
    expect(versions.rows[0]?.count).toBe(0);
    expect(appState.rows[0]?.pipeline_state).toBe("DOCUMENTS_REQUIRED");
  });

  it("keeps accepted documents when pipeline advance fails", async () => {
    const { token } = await loginAsStaff();
    const applicationId = await createApplication(token);
    const bank = await uploadDocument(token, applicationId, "bank_statement", "Bank Statement");
    const idDoc = await uploadDocument(token, applicationId, "id_document", "ID Document");

    await acceptDocument(token, applicationId, bank);
    await acceptDocument(token, applicationId, idDoc);

    setDbTestFailureInjection({
      mode: "connection_reset",
      remaining: 1,
      matchQuery: "update applications",
    });

    const failed = await request(app)
      .post(`/api/applications/${applicationId}/pipeline`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("x-request-id", nextRequestId())
      .send({ state: "OFF_TO_LENDER" });

    expect(failed.status).toBe(503);

    const [reviews, state] = await Promise.all([
      pool.query(
        `select count(*)::int as count
         from document_version_reviews r
         join document_versions dv on dv.id = r.document_version_id
         join documents d on d.id = dv.document_id
         where d.application_id = $1
           and r.status = 'accepted'`,
        [applicationId]
      ),
      pool.query<{ pipeline_state: string }>(
        "select pipeline_state from applications where id = $1",
        [applicationId]
      ),
    ]);

    expect(reviews.rows[0]?.count).toBe(2);
    expect(state.rows[0]?.pipeline_state).toBe("IN_REVIEW");
  });

  it("keeps lender submission failures consistent and idempotent", async () => {
    const { token } = await loginAsStaff();
    const applicationId = await createApplication(token);
    const bank = await uploadDocument(token, applicationId, "bank_statement", "Bank Statement");
    const idDoc = await uploadDocument(token, applicationId, "id_document", "ID Document");

    await acceptDocument(token, applicationId, bank);
    await acceptDocument(token, applicationId, idDoc);
    await pool.query("update applications set metadata = $1 where id = $2", [
      { forceFailure: true },
      applicationId,
    ]);

    const idemKey = nextIdempotencyKey();
    const failed = await submitToLender(token, applicationId, defaultLenderId, defaultLenderProductId, idemKey);

    expect(failed.status).toBe(502);
    expect(failed.body.submission.status).toBe("failed");
    expect(failed.body.submission.failureReason).toBe("lender_error");

    const submissionId = failed.body.submission.id;

    const [submissionRow, retryRow, state] = await Promise.all([
      pool.query(
        `select status, failure_reason
         from lender_submissions
         where id = $1`,
        [submissionId]
      ),
      pool.query(
        `select status
         from lender_submission_retries
         where submission_id = $1`,
        [submissionId]
      ),
      pool.query<{ pipeline_state: string }>(
        "select pipeline_state from applications where id = $1",
        [applicationId]
      ),
    ]);

    expect(submissionRow.rows[0]?.status).toBe("failed");
    expect(submissionRow.rows[0]?.failure_reason).toBe("lender_error");
    expect(retryRow.rows[0]?.status).toBe("pending");
    expect(state.rows[0]?.pipeline_state).toBe("DOCUMENTS_REQUIRED");

    const retry = await submitToLender(token, applicationId, defaultLenderId, defaultLenderProductId, idemKey);
    expect(retry.status).toBe(200);
    expect(retry.body.submission.id).toBe(submissionId);
    expect(retry.body.submission.status).toBe("failed");
  });

  it(
    "handles 25 concurrent submissions without exhausting the pool",
    async () => {
    const { token } = await loginAsStaff();

    const submissions = await withTimeout(
      Promise.all(
        Array.from({ length: 25 }, async (_value, index) => {
          const applicationId = await createApplication(token);
          const bank = await uploadDocument(
            token,
            applicationId,
            "bank_statement",
            `Bank Statement ${index}`
          );
          const idDoc = await uploadDocument(
            token,
            applicationId,
            "id_document",
            `ID Document ${index}`
          );
          await acceptDocument(token, applicationId, bank);
          await acceptDocument(token, applicationId, idDoc);
          const submission = await submitToLender(token, applicationId);
          return { applicationId, submission };
        })
      ),
      60000
    );

    submissions.forEach(({ submission }) => {
      expect(submission.status).toBe(201);
      expect(submission.body.submission.status).toBe("submitted");
    });

    const retryCount = await pool.query<{ count: number }>(
      "select count(*)::int as count from lender_submission_retries"
    );
    expect(retryCount.rows[0]?.count).toBe(0);

    const poolState = pool as unknown as {
      totalCount?: number;
      idleCount?: number;
      waitingCount?: number;
      options?: { max?: number };
    };
    expect(poolState.waitingCount ?? 0).toBe(0);
    expect(poolState.totalCount ?? 0).toBeLessThanOrEqual(poolState.options?.max ?? 2);
    expect(poolState.idleCount ?? 0).toBeGreaterThanOrEqual(0);
    },
    120000
  );
});
