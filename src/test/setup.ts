import { installProcessHandlers } from "../observability/processHandlers";
import { markReady } from "../startupState";
import { vi } from "vitest";
import {
  getExpectedTwilioSignature,
  twilioDefaultExport,
  twilioMockState,
  validateExpressRequest,
  validateRequest,
} from "./twilioMock";

vi.mock("twilio", () => ({
  default: twilioDefaultExport,
  validateRequest,
  validateExpressRequest,
  getExpectedTwilioSignature,
  __twilioMocks: twilioMockState,
}));

process.env.NODE_ENV = "test";
process.env.BASE_URL ||= "http://127.0.0.1:3000";
process.env.RUN_MIGRATIONS = "false";
process.env.DB_READY_ATTEMPTS = "1";
process.env.DB_READY_BASE_DELAY_MS = "1";
process.env.TWILIO_ACCOUNT_SID = "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env.TWILIO_AUTH_TOKEN = "test-auth-token-1234567890";
process.env.TWILIO_VERIFY_SERVICE_SID = "VA00000000000000000000000000000000";
process.env.TWILIO_API_KEY = "SKXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env.TWILIO_API_SECRET = "test-twilio-api-secret";
process.env.TWILIO_VOICE_APP_SID = "AP00000000000000000000000000000000";
process.env.TWILIO_VOICE_CALLER_ID = "+14155550000";
process.env.JWT_SECRET = "test-access-secret";
process.env.TEST_OTP_CODE = "123456";

markReady();
installProcessHandlers();

beforeAll(async () => {
  const { pool } = await import("../db");
  await pool.query("drop table if exists applications cascade;");
  await pool.query("drop table if exists reports cascade;");
  await pool.query("drop table if exists voice_logs cascade;");
  await pool.query("drop table if exists idempotency_keys cascade;");
  await pool.query("drop table if exists auth_refresh_tokens cascade;");
  await pool.query("drop table if exists otp_verifications cascade;");
  await pool.query("drop table if exists otp_sessions cascade;");
  await pool.query("drop table if exists otp_codes cascade;");
  await pool.query("drop table if exists audit_events cascade;");
  await pool.query("drop table if exists lenders cascade;");
  await pool.query("drop table if exists users cascade;");

  await pool.query(`
    create table if not exists users (
      id uuid primary key,
      email text null,
      phone_number text null unique,
      phone text null,
      role text null,
      silo text null,
      lender_id uuid null,
      status text not null default 'ACTIVE',
      active boolean not null default true,
      is_active boolean null,
      disabled boolean null,
      locked_until timestamptz null,
      phone_verified boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      token_version integer not null default 0
    );
  `);
  await pool.query(`
    create table if not exists applications (
      id uuid primary key,
      user_id uuid null references users(id) on delete set null,
      owner_user_id uuid null references users(id) on delete set null,
      name text null,
      metadata jsonb null,
      product_type text null,
      product_category text null,
      pipeline_state text null,
      current_stage text null,
      processing_stage text null,
      status text null,
      application_status text null,
      is_completed boolean not null default false,
      last_updated timestamptz null,
      lender_id uuid null,
      lender_product_id uuid null,
      requested_amount numeric null,
      source text null,
      first_opened_at timestamptz null,
      ocr_completed_at timestamptz null,
      banking_completed_at timestamptz null,
      credit_summary_completed_at timestamptz null,
      startup_flag boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`create table if not exists reports (id uuid primary key, user_id uuid null references users(id) on delete set null, created_at timestamptz not null default now());`);
  await pool.query(`create table if not exists voice_logs (id uuid primary key, user_id uuid null references users(id) on delete set null, created_at timestamptz not null default now());`);
  await pool.query(`
    create table if not exists documents (
      id uuid primary key,
      application_id uuid null references applications(id) on delete cascade,
      owner_user_id uuid null references users(id) on delete set null,
      title text null,
      document_type text null,
      status text null,
      filename text null,
      storage_key text null,
      uploaded_by text null,
      rejection_reason text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists application_stage_events (
      id uuid primary key,
      application_id uuid not null references applications(id) on delete cascade,
      from_stage text null,
      to_stage text not null,
      trigger text null,
      triggered_by text null,
      reason text null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists application_required_documents (
      id uuid primary key,
      application_id uuid not null references applications(id) on delete cascade,
      document_category text not null,
      is_required boolean not null default true,
      status text not null default 'PENDING',
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create unique index if not exists application_required_documents_app_doc_uidx
      on application_required_documents (application_id, document_category);
  `);
  await pool.query(`
    create table if not exists document_versions (
      id uuid primary key,
      document_id uuid not null references documents(id) on delete cascade,
      version integer not null default 1,
      blob_name text null,
      hash text null,
      metadata jsonb null,
      content text null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists document_version_reviews (
      id uuid primary key,
      document_version_id uuid not null references document_versions(id) on delete cascade,
      status text not null,
      reviewed_by_user_id uuid null references users(id) on delete set null,
      reviewed_at timestamptz null,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists idempotency_keys (
      id uuid primary key,
      key text not null,
      route text not null,
      method text null,
      request_hash text null,
      response_code integer not null,
      response_body jsonb null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists auth_refresh_tokens (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      token text not null,
      token_hash text not null,
      expires_at timestamptz not null,
      revoked_at timestamptz null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists otp_sessions (
      id uuid primary key default gen_random_uuid(),
      phone text not null,
      code text not null,
      created_at timestamp not null default now(),
      expires_at timestamp not null
    );
  `);
  await pool.query(`create index if not exists idx_otp_phone on otp_sessions(phone);`);
  await pool.query(`
    create table if not exists otp_codes (
      id uuid primary key,
      phone text not null,
      code text not null,
      attempts int not null default 0,
      consumed boolean not null default false,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    );
  `);
  await pool.query(`create index if not exists otp_codes_phone_idx on otp_codes(phone);`);
  await pool.query(`
    create table if not exists otp_verifications (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      phone text not null,
      verification_sid text,
      status text not null,
      verified_at timestamptz,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists audit_events (
      actor_user_id uuid null,
      target_user_id uuid null,
      target_type text null,
      target_id text null,
      event_type text not null,
      event_action text not null,
      ip_address text null,
      user_agent text null,
      request_id text null,
      success boolean not null,
      metadata jsonb null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists lenders (
      id uuid primary key,
      name text not null,
      active boolean not null default true,
      status text not null default 'ACTIVE',
      country text not null,
      submission_method text not null default 'email',
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
  `);
  await pool.query(`
    create table if not exists lender_products (
      id uuid primary key,
      lender_id uuid not null references lenders(id) on delete cascade,
      name text not null,
      category text not null default 'LOC',
      country text not null default 'US',
      rate_type text null,
      interest_min text null,
      interest_max text null,
      term_min integer null,
      term_max integer null,
      term_unit text not null default 'MONTHS',
      active boolean not null default true,
      required_documents jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists contacts (
      id uuid primary key,
      company_id uuid null,
      company text null,
      name text null,
      email text null,
      phone text null,
      status text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists companies (
      id uuid primary key,
      name text null,
      email text null,
      phone text null,
      status text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists continuation (
      id uuid primary key,
      application_id uuid null references applications(id) on delete set null,
      company_name text null,
      full_name text null,
      email text null,
      phone text null,
      industry text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists issue_reports (
      id uuid primary key default gen_random_uuid(),
      description text null,
      screenshot_base64 text null,
      screenshot_path text null,
      page_url text null,
      browser_info text null,
      user_agent text null,
      status text null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists crm_leads (
      id uuid primary key,
      company_name text null,
      full_name text null,
      email text null,
      phone text null,
      industry text null,
      years_in_business text null,
      monthly_revenue text null,
      annual_revenue text null,
      ar_outstanding text null,
      existing_debt text null,
      source text null,
      tags jsonb null default '[]'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists crm_lead_activities (
      id uuid primary key,
      lead_id uuid not null references crm_leads(id) on delete cascade,
      activity_type text not null,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists readiness_leads (
      id uuid primary key,
      company_name text not null,
      full_name text not null,
      phone text not null,
      email text not null,
      industry text null,
      years_in_business integer null,
      monthly_revenue numeric null,
      annual_revenue numeric null,
      ar_outstanding numeric null,
      existing_debt boolean null,
      source text not null default 'website',
      status text not null default 'new',
      crm_contact_id uuid null references contacts(id) on delete set null,
      application_id uuid null references applications(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists readiness_sessions (
      id uuid primary key,
      token uuid not null,
      email text not null,
      phone text null,
      company_name text not null,
      full_name text not null,
      industry text null,
      years_in_business integer null,
      monthly_revenue numeric null,
      annual_revenue numeric null,
      ar_outstanding numeric null,
      existing_debt boolean null,
      crm_lead_id uuid null references crm_leads(id) on delete set null,
      is_active boolean not null default true,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists chat_sessions (
      id uuid primary key,
      user_type text null,
      source text null,
      channel text null,
      status text not null,
      lead_id uuid null references contacts(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists ai_sessions (
      id uuid primary key,
      visitor_id uuid null,
      context text null,
      source text null,
      status text null,
      company_name text null,
      full_name text null,
      email text null,
      phone text null,
      startup_interest_tags jsonb null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists ai_messages (
      id uuid primary key,
      session_id uuid not null references ai_sessions(id) on delete cascade,
      role text not null,
      content text not null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists communications_messages (
      id uuid primary key,
      type text null,
      direction text null,
      status text null,
      contact_id uuid null references contacts(id) on delete set null,
      body text null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists application_continuations (
      token text primary key,
      prefill_json jsonb null,
      status text null,
      crm_lead_id uuid null references crm_leads(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists document_processing_jobs (
      id uuid primary key default gen_random_uuid(),
      application_id uuid null references applications(id) on delete cascade,
      document_id uuid null references documents(id) on delete cascade,
      job_type text not null default 'ocr',
      provider text null,
      status text not null default 'pending',
      started_at timestamptz null,
      retry_count integer not null default 0,
      last_retry_at timestamptz null,
      max_retries integer not null default 3,
      error_code text null,
      error_message text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      completed_at timestamptz null
    );
  `);
  await pool.query(`
    create unique index if not exists document_processing_jobs_doc_type_uidx
      on document_processing_jobs (document_id, job_type);
  `);
  await pool.query(`
    create table if not exists banking_analysis_jobs (
      id uuid primary key default gen_random_uuid(),
      application_id uuid not null references applications(id) on delete cascade,
      status text not null default 'pending',
      statement_months_detected integer null,
      started_at timestamptz null,
      completed_at timestamptz null,
      error_message text null,
      retry_count integer not null default 0,
      last_retry_at timestamptz null,
      max_retries integer not null default 3,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists contact_leads (
      id uuid primary key default gen_random_uuid(),
      company text null,
      first_name text null,
      last_name text null,
      email text null,
      phone text null,
      payload jsonb null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists client_submissions (
      id uuid primary key,
      submission_key text null,
      application_id uuid null references applications(id) on delete set null,
      payload jsonb null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists application_pipeline_history (
      id uuid primary key,
      application_id uuid not null references applications(id) on delete cascade,
      from_state text null,
      to_state text not null,
      reason text null,
      actor_user_id uuid null references users(id) on delete set null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists document_status_history (
      id uuid primary key,
      document_id uuid not null references documents(id) on delete cascade,
      from_status text null,
      to_status text not null,
      reason text null,
      actor_user_id uuid null references users(id) on delete set null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists processing_job_history (
      id uuid primary key,
      job_id uuid null references document_processing_jobs(id) on delete cascade,
      application_id uuid null references applications(id) on delete cascade,
      from_status text null,
      to_status text not null,
      reason text null,
      created_at timestamptz not null default now()
    );
  `);
});

Object.assign(globalThis, { __twilioMocks: twilioMockState });
