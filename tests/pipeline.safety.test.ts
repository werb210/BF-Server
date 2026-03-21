import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES } from "../src/auth/roles";
import { ensureAuditEventSchema } from "../src/__tests__/helpers/auditSchema";
import { otpVerifyRequest } from "../src/__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "pipeline-safety-test";
let phoneCounter = 8600;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function ensurePipelineSchema(): Promise<void> {
  await pool.query(`
    create table if not exists applications (
      id text primary key,
      owner_user_id uuid not null references users(id) on delete cascade,
      name text not null,
      metadata jsonb null,
      product_type text not null,
      pipeline_state text not null,
      processing_stage text not null default 'pending',
      status text not null default 'RECEIVED',
      lender_id uuid null,
      lender_product_id uuid null,
      requested_amount integer null,
      source text null,
      created_at timestamp not null,
      updated_at timestamp not null
    );
  `);
  await pool.query(`
    create table if not exists documents (
      id text primary key,
      application_id text not null references applications(id) on delete cascade,
      owner_user_id uuid not null references users(id) on delete cascade,
      title text not null,
      document_type text not null,
      version integer not null default 1,
      status text not null default 'uploaded',
      created_at timestamp not null
    );
  `);
  await pool.query(`
    create table if not exists document_versions (
      id text primary key,
      document_id text not null references documents(id) on delete cascade,
      version integer not null,
      metadata jsonb not null,
      content text not null,
      created_at timestamp not null,
      unique (document_id, version)
    );
  `);
  await pool.query(`
    create table if not exists document_version_reviews (
      id text primary key,
      document_version_id text not null references document_versions(id) on delete cascade,
      status text not null,
      reviewed_by_user_id uuid null references users(id) on delete set null,
      reviewed_at timestamp not null,
      unique (document_version_id)
    );
  `);
  await pool.query(`
    create table if not exists lender_submissions (
      id text primary key,
      application_id text not null references applications(id) on delete cascade,
      status text not null,
      idempotency_key text null,
      lender_id text not null default 'default',
      submission_method text null,
      submitted_at timestamp null,
      payload jsonb null,
      payload_hash text null,
      lender_response jsonb null,
      response_received_at timestamp null,
      failure_reason text null,
      external_reference text null,
      created_at timestamp not null,
      updated_at timestamp not null
    );
  `);
  await pool.query("drop table if exists lender_submission_retries");
  await pool.query(`
    create table lender_submission_retries (
      id text primary key,
      submission_id text not null references lender_submissions(id) on delete cascade,
      status text not null,
      attempt_count integer not null,
      next_attempt_at timestamp null,
      last_error text null,
      created_at timestamp not null,
      updated_at timestamp not null,
      canceled_at timestamp null,
      unique (submission_id)
    );
  `);
  await pool.query(`
    create table if not exists ops_kill_switches (
      key text primary key,
      enabled boolean not null,
      updated_at timestamp not null
    );
  `);
}

async function resetDb(): Promise<void> {
  await pool.query("delete from lender_submission_retries");
  await pool.query("delete from lender_submissions");
  await pool.query("delete from ops_kill_switches");
  await pool.query("delete from document_version_reviews");
  await pool.query("delete from document_versions");
  await pool.query("delete from documents");
  await pool.query("delete from applications");
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from audit_events");
  await pool.query("delete from lenders");
  await pool.query("delete from lender_products");
  await pool.query(
    "delete from users where id <> '00000000-0000-0000-0000-000000000001'"
  );
}

async function seedRequirements(): Promise<void> {
  await pool.query(
    `insert into lenders (id, name, country, submission_method, active, status, created_at, updated_at)\n     values ('00000000-0000-0000-0000-00000000d001', 'Pipeline Lender', 'US', 'api', true, 'ACTIVE', now(), now())\n     on conflict (id) do nothing`
  );
  await pool.query(
    `insert into lender_products\n     (id, lender_id, name, category, country, rate_type, interest_min, interest_max, term_min, term_max, term_unit, active, required_documents, created_at, updated_at)\n     values (\n       '00000000-0000-0000-0000-00000000d002',\n       '00000000-0000-0000-0000-00000000d001',\n       'Pipeline LOC',\n       'LOC',\n       'US',\n       'FIXED',\n       '8.5',\n       '12.5',\n       6,\n       24,\n       'MONTHS',\n       true,\n       '[{\"type\":\"bank_statement\",\"months\":6},{\"type\":\"id_document\",\"required\":true}]'::jsonb,\n       now(),\n       now()\n     )\n     on conflict (id) do nothing`
  );
}

beforeAll(async () => {
  process.env.BUILD_TIMESTAMP = "2024-01-01T00:00:00.000Z";
  process.env.COMMIT_SHA = "test-commit";
  process.env.JWT_SECRET = "test-access-secret";
  process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
  process.env.JWT_EXPIRES_IN = "15m";
  process.env.JWT_REFRESH_EXPIRES_IN = "30d";
  process.env.LOGIN_LOCKOUT_THRESHOLD = "2";
  process.env.LOGIN_LOCKOUT_MINUTES = "10";
  process.env.PASSWORD_MAX_AGE_DAYS = "30";
  process.env.NODE_ENV = "test";
  await ensureAuditEventSchema();
  await ensurePipelineSchema();
});

beforeEach(async () => {
  await resetDb();
  await seedRequirements();
  phoneCounter = 8600;
});

afterAll(async () => {
  await pool.end();
});

describe("pipeline safety", () => {
  it("rejects invalid pipeline transitions", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: `staff-${phone}@example.com`,
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey: `idem-pipeline-${phone}`,
    });
    expect(login.status).toBe(200);

    const create = await request(app || require("../src/app").default)
      .post("/api/applications")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("Idempotency-Key", `idem-app-${phone}`)
      .set("x-request-id", requestId)
      .send({ name: "Pipeline App", productType: "standard" });

    expect(create.status).toBe(201);

    const transition = await request(app || require("../src/app").default)
      .post(`/api/applications/${create.body.application.id}/pipeline`)
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("Idempotency-Key", `idem-transition-${phone}`)
      .set("x-request-id", requestId)
      .send({ state: "OFF_TO_LENDER" });

    expect(transition.status).toBe(400);
    expect(transition.body.error).toBe("invalid_transition");
  });

  it("logs overrides when pipeline state changes", async () => {
    const phone = nextPhone();
    const user = await createUserAccount({
      email: `override-${phone}@example.com`,
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey: `idem-override-${phone}`,
    });
    expect(login.status).toBe(200);

    const create = await request(app || require("../src/app").default)
      .post("/api/applications")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("Idempotency-Key", `idem-app-override-${phone}`)
      .set("x-request-id", requestId)
      .send({ name: "Override App", productType: "standard" });

    expect(create.status).toBe(201);

    await pool.query(
      "update applications set pipeline_state = 'IN_REVIEW' where id = $1",
      [create.body.application.id]
    );

    const transition = await request(app || require("../src/app").default)
      .post(`/api/applications/${create.body.application.id}/pipeline`)
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("Idempotency-Key", `idem-transition-override-${phone}`)
      .set("x-request-id", requestId)
      .send({ state: "START_UP", override: true });

    expect(transition.status).toBe(200);

    const audit = await pool.query(
      `select event_action as action
       from audit_events
       where actor_user_id = $1
         and event_action = 'admin_override'`,
      [user.id]
    );

    expect(audit.rows.length).toBe(1);
  });

  it("blocks lender submissions when required documents are missing", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: `submit-${phone}@example.com`,
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone,
      requestId,
      idempotencyKey: `idem-submit-${phone}`,
    });
    expect(login.status).toBe(200);

    const create = await request(app || require("../src/app").default)
      .post("/api/applications")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("Idempotency-Key", `idem-app-submit-${phone}`)
      .set("x-request-id", requestId)
      .send({ name: "Submission App", productType: "standard" });

    await pool.query(
      "update applications set lender_id = $1, lender_product_id = $2 where id = $3",
      [
        "00000000-0000-0000-0000-00000000d001",
        "00000000-0000-0000-0000-00000000d002",
        create.body.application.id,
      ]
    );

    const submission = await request(app || require("../src/app").default)
      .post("/api/lender/submissions")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("Idempotency-Key", `idem-submit-request-${phone}`)
      .set("x-request-id", requestId)
      .send({
        applicationId: create.body.application.id,
        lenderId: "00000000-0000-0000-0000-00000000d001",
        lenderProductId: "00000000-0000-0000-0000-00000000d002",
      });

    expect(submission.status).toBe(400);
    expect(submission.body.submission.status).toBe("failed");
    expect(submission.body.submission.failureReason).toBe("missing_documents");
  });
});
