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
  await pool.query("drop table if exists contacts cascade;");
  await pool.query("drop table if exists crm_leads cascade;");
  await pool.query("drop table if exists crm_lead_activities cascade;");
  await pool.query("drop table if exists issue_reports cascade;");
  await pool.query("drop table if exists readiness_leads cascade;");
  await pool.query("drop table if exists readiness_sessions cascade;");
  await pool.query("drop table if exists application_continuations cascade;");
  await pool.query("drop table if exists continuation cascade;");
  await pool.query("drop table if exists chat_sessions cascade;");
  await pool.query("drop table if exists ai_sessions cascade;");
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
      current_step integer not null default 0,
      last_updated timestamptz not null default now(),
      is_completed boolean not null default false,
      lender_id uuid null,
      lender_product_id uuid null,
      requested_amount numeric null,
      source text null,
      submission_key text null,
      external_id text null,
      client_submission_id text null,
      first_opened_at timestamptz null,
      ocr_completed_at timestamptz null,
      banking_completed_at timestamptz null,
      credit_summary_completed_at timestamptz null,
      startup_flag boolean null,
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
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
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
    create table if not exists document_processing_jobs (
      id uuid primary key,
      application_id uuid null references applications(id) on delete cascade,
      document_id uuid null references documents(id) on delete cascade,
      provider text null,
      status text not null default 'queued',
      retry_count integer not null default 0,
      max_retries integer not null default 3,
      error_code text null,
      error_message text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      completed_at timestamptz null
    );
  `);
  await pool.query(`
    create table if not exists contact_leads (
      id uuid primary key,
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
    create table if not exists contacts (
      id uuid primary key,
      company_id uuid null,
      name text null,
      email text null,
      phone text null,
      status text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists crm_leads (
      id uuid primary key,
      full_name text null,
      email text null,
      phone text null,
      company_name text null,
      industry text null,
      years_in_business integer null,
      monthly_revenue numeric null,
      annual_revenue numeric null,
      ar_outstanding numeric null,
      existing_debt boolean null,
      source text null,
      tags jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists crm_lead_activities (
      id uuid primary key,
      lead_id uuid not null references crm_leads(id) on delete cascade,
      activity_type text not null,
      payload jsonb null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists issue_reports (
      id uuid primary key,
      session_id uuid null,
      description text null,
      page_url text null,
      browser_info text null,
      screenshot_path text null,
      screenshot_base64 text null,
      user_agent text null,
      status text not null default 'open',
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists continuation (
      id uuid primary key,
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
    create table if not exists chat_sessions (
      id uuid primary key,
      user_type text not null,
      status text not null,
      source text null,
      escalated_to uuid null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists ai_sessions (
      id uuid primary key,
      source text null,
      status text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists readiness_leads (
      id uuid primary key,
      company_name text null,
      full_name text null,
      email text null,
      phone text null,
      industry text null,
      years_in_business integer null,
      monthly_revenue numeric null,
      annual_revenue numeric null,
      ar_outstanding numeric null,
      existing_debt boolean null,
      source text null,
      status text null,
      token text null,
      crm_contact_id uuid null,
      converted_application_id uuid null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists readiness_sessions (
      id uuid primary key,
      token text not null,
      lead_id uuid null references readiness_leads(id) on delete cascade,
      crm_lead_id uuid null,
      email text null,
      phone text null,
      company_name text null,
      full_name text null,
      industry text null,
      years_in_business integer null,
      monthly_revenue numeric null,
      annual_revenue numeric null,
      ar_outstanding numeric null,
      existing_debt boolean null,
      prefill_json jsonb null,
      expires_at timestamptz not null,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists application_continuations (
      token text primary key,
      company_name text null,
      full_name text null,
      email text null,
      phone text null,
      industry text null,
      years_in_business integer null,
      monthly_revenue numeric null,
      annual_revenue numeric null,
      ar_outstanding numeric null,
      existing_debt boolean null,
      crm_lead_id uuid null,
      prefill_json jsonb null,
      status text null,
      converted_application_id uuid null,
      converted_at timestamptz null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists application_required_documents (
      id uuid primary key,
      application_id uuid not null references applications(id) on delete cascade,
      document_category text not null,
      is_required boolean not null default true,
      status text not null default 'missing',
      created_at timestamptz not null default now(),
      unique (application_id, document_category)
    );
  `);
  await pool.query(`
    create table if not exists application_stage_events (
      id uuid primary key,
      application_id uuid not null references applications(id) on delete cascade,
      from_stage text null,
      to_stage text not null,
      trigger text not null,
      triggered_by text not null,
      reason text null,
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
