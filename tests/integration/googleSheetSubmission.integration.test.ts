import { randomUUID } from "crypto";
import { pool } from "../../src/db";
import { createUserAccount } from "../../src/modules/auth/auth.service";
import { ROLES } from "../../src/auth/roles";
import { submitApplication } from "../../src/modules/lender/lender.service";

const submitMock = vi.fn();

vi.mock("../../src/modules/submissions/adapters/GoogleSheetSubmissionAdapter", () => ({
  GoogleSheetSubmissionAdapter: vi.fn().mockImplementation(() => ({
    submit: submitMock,
  })),
}));

let phoneCounter = 1400;
const nextPhone = (): string => `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function seedLenderProduct(): Promise<{ lenderId: string; lenderProductId: string }> {
  const lenderId = randomUUID();
  const lenderProductId = randomUUID();
  await pool.query(
    `insert into lenders (id, name, country, submission_method, submission_email, submission_config, active, status, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, true, 'ACTIVE', now(), now())`,
    [
      lenderId,
      "Merchant Growth",
      "US",
      "google_sheet",
      null,
      {
        spreadsheetId: "sheet-123",
        sheetName: "Sheet1",
        columnMapVersion: "v1",
      },
    ]
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
  const tables = [
    "submission_events",
    "client_submissions",
    "lender_submission_retries",
    "lender_submissions",
    "ops_kill_switches",
    "document_version_reviews",
    "document_versions",
    "documents",
    "applications",
    "idempotency_keys",
    "otp_verifications",
    "auth_refresh_tokens",
    "password_resets",
    "audit_events",
  ];
  for (const table of tables) {
    try {
      await pool.query(`delete from ${table}`);
    } catch {
      // ignore missing tables in pg-mem
    }
  }
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
}

async function seedApplicationWithDocuments(params: {
  lenderId: string;
  lenderProductId: string;
  ownerUserId: string;
}): Promise<string> {
  const applicationId = randomUUID();
  await pool.query(
    `insert into applications
     (id, owner_user_id, name, metadata, product_type, pipeline_state, lender_id, lender_product_id, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())`,
    [
      applicationId,
      params.ownerUserId,
      "Lender Application",
      { applicant: { firstName: "Jane" }, business: { legalName: "Biz" } },
      "standard",
      "IN_REVIEW",
      params.lenderId,
      params.lenderProductId,
    ]
  );

  const bankDocumentId = randomUUID();
  const bankVersionId = randomUUID();
  await pool.query(
    `insert into documents (id, application_id, owner_user_id, title, document_type, status, created_at)
     values ($1, $2, $3, $4, $5, $6, now())`,
    [bankDocumentId, applicationId, params.ownerUserId, "Bank Statement", "bank_statement", "accepted"]
  );
  await pool.query(
    `insert into document_versions (id, document_id, version, metadata, content, created_at)
     values ($1, $2, $3, $4, $5, now())`,
    [bankVersionId, bankDocumentId, 1, { fileName: "bank.pdf" }, "base64data"]
  );
  await pool.query(
    `insert into document_version_reviews (id, document_version_id, status, reviewed_by_user_id, reviewed_at)
     values ($1, $2, $3, $4, now())`,
    [randomUUID(), bankVersionId, "accepted", params.ownerUserId]
  );

  const idDocumentId = randomUUID();
  const idVersionId = randomUUID();
  await pool.query(
    `insert into documents (id, application_id, owner_user_id, title, document_type, status, created_at)
     values ($1, $2, $3, $4, $5, $6, now())`,
    [idDocumentId, applicationId, params.ownerUserId, "ID", "id_document", "accepted"]
  );
  await pool.query(
    `insert into document_versions (id, document_id, version, metadata, content, created_at)
     values ($1, $2, $3, $4, $5, now())`,
    [idVersionId, idDocumentId, 1, { fileName: "id.pdf" }, "iddata"]
  );
  await pool.query(
    `insert into document_version_reviews (id, document_version_id, status, reviewed_by_user_id, reviewed_at)
     values ($1, $2, $3, $4, now())`,
    [randomUUID(), idVersionId, "accepted", params.ownerUserId]
  );

  return applicationId;
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  await pool.query(`
    create table if not exists applications (
      id uuid,
      owner_user_id uuid,
      name text,
      metadata jsonb,
      product_type text,
      pipeline_state text,
      processing_stage text default 'pending',
      status text,
      lender_id uuid,
      lender_product_id uuid,
      requested_amount integer,
      source text,
      created_at timestamptz,
      updated_at timestamptz
    );
  `);
  await pool.query(`
    create table if not exists lenders (
      id uuid,
      name text,
      active boolean,
      status text,
      country text,
      submission_method text,
      submission_email text,
      submission_config jsonb,
      created_at timestamptz,
      updated_at timestamptz
    );
  `);
  await pool.query(`
    create table if not exists lender_products (
      id uuid,
      lender_id uuid,
      name text,
      category text,
      country text,
      rate_type text,
      interest_min text,
      interest_max text,
      term_min integer,
      term_max integer,
      term_unit text,
      active boolean,
      required_documents jsonb,
      created_at timestamptz,
      updated_at timestamptz
    );
  `);
  await pool.query(`
    create table if not exists documents (
      id uuid,
      application_id uuid,
      owner_user_id uuid,
      title text,
      document_type text,
      status text,
      created_at timestamptz
    );
  `);
  await pool.query(`
    create table if not exists document_versions (
      id uuid,
      document_id uuid,
      version integer,
      metadata jsonb,
      content text,
      created_at timestamptz
    );
  `);
  await pool.query(`
    create table if not exists document_version_reviews (
      id uuid,
      document_version_id uuid,
      status text,
      reviewed_by_user_id uuid,
      reviewed_at timestamptz
    );
  `);
  await pool.query(`
    create table if not exists lender_submissions (
      id uuid,
      application_id uuid,
      status text,
      idempotency_key text,
      lender_id uuid,
      submission_method text,
      submitted_at timestamptz,
      payload jsonb,
      payload_hash text,
      lender_response jsonb,
      response_received_at timestamptz,
      failure_reason text,
      external_reference text,
      created_at timestamptz,
      updated_at timestamptz
    );
  `);
  await pool.query(`
    create table if not exists lender_submission_retries (
      id uuid,
      submission_id uuid,
      status text,
      attempt_count integer,
      next_attempt_at timestamptz,
      last_error text,
      created_at timestamptz,
      updated_at timestamptz,
      canceled_at timestamptz
    );
  `);
  await pool.query(`
    create table if not exists submission_events (
      id uuid,
      application_id uuid,
      lender_id uuid,
      method text,
      status text,
      internal_error text,
      created_at timestamptz
    );
  `);
  await pool.query(`
    create table if not exists ops_kill_switches (
      key text,
      enabled boolean,
      updated_at timestamptz
    );
  `);
});

beforeEach(async () => {
  await resetDb();
  phoneCounter = 1400;
  submitMock.mockResolvedValue({
    success: true,
    response: { status: "appended", receivedAt: new Date().toISOString(), externalReference: "2" },
    failureReason: null,
    retryable: false,
  });
});

afterAll(async () => {
  await pool.end();
});

describe("google sheet submission routing", () => {
  it("routes submissions to the Google Sheet adapter", async () => {
    const staffPhone = nextPhone();
    const staffUser = await createUserAccount({
      email: "lender@apps.com",
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const { lenderId, lenderProductId } = await seedLenderProduct();
    const applicationId = await seedApplicationWithDocuments({
      lenderId,
      lenderProductId,
      ownerUserId: staffUser.id,
    });

    const submission = await submitApplication({
      applicationId,
      idempotencyKey: null,
      lenderId,
      lenderProductId,
      actorUserId: staffUser.id,
    });

    expect(submission.statusCode).toBe(201);
    expect(submission.value.status).toBe("submitted");
    expect(submitMock).toHaveBeenCalledTimes(1);

    const { rows } = await pool.query(
      "select status from submission_events where application_id = $1 order by created_at asc",
      [applicationId]
    );
    expect(rows.map((row) => row.status)).toEqual(["pending", "submitted"]);
  });

  it("blocks duplicate submissions for the same application", async () => {
    const staffPhone = nextPhone();
    const staffUser = await createUserAccount({
      email: "lender2@apps.com",
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const { lenderId, lenderProductId } = await seedLenderProduct();
    const applicationId = await seedApplicationWithDocuments({
      lenderId,
      lenderProductId,
      ownerUserId: staffUser.id,
    });

    const first = await submitApplication({
      applicationId,
      idempotencyKey: null,
      lenderId,
      lenderProductId,
      actorUserId: staffUser.id,
    });
    const second = await submitApplication({
      applicationId,
      idempotencyKey: null,
      lenderId,
      lenderProductId,
      actorUserId: staffUser.id,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.idempotent).toBe(true);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });
});
