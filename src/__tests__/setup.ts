import { installProcessHandlers } from "../observability/processHandlers";
import { markReady } from "../startupState";

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
process.env.VAPID_PUBLIC_KEY =
  "BEfWI4_C2Dzb-Nwj0lrRCX3tjsD6SHII7rSHm2T-NsJUdP6KBpfPoAggWrkxCbxat6Vv8O-HBZzYnzHvTT8uh1Q";
process.env.VAPID_PRIVATE_KEY = "rkOdsYGnG4F-cu0nkuG6Zi5dTlFtOmzLUGCCUyYZZqY";
process.env.VAPID_SUBJECT = "mailto:tests@example.com";
process.env.LOGIN_LOCKOUT_THRESHOLD = "2";
process.env.LOGIN_LOCKOUT_MINUTES = "10";
process.env.PASSWORD_MAX_AGE_DAYS = "30";

markReady();
installProcessHandlers();

beforeAll(async () => {
  const { pool } = await import("../db");
  await pool.query("drop table if exists idempotency_keys cascade;");
  await pool.query("drop table if exists auth_refresh_tokens cascade;");
  await pool.query("drop table if exists otp_verifications cascade;");
  await pool.query("drop table if exists otp_sessions cascade;");
  await pool.query("drop table if exists audit_events cascade;");
  await pool.query("drop table if exists lenders cascade;");
  await pool.query("drop table if exists users cascade;");
  await pool.query("drop table if exists pwa_subscriptions cascade;");
  await pool.query("drop table if exists pwa_notifications cascade;");
  await pool.query("drop table if exists call_logs cascade;");
  await pool.query("drop type if exists call_status_enum cascade;");
  await pool.query("drop type if exists call_direction_enum cascade;");
  await pool.query(`
    create table if not exists users (
      id uuid primary key,
      email text null,
      phone_number text null unique,
      phone text null,
      first_name text null,
      last_name text null,
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
      updated_at timestamptz null,
      last_login_at timestamptz null,
      token_version integer not null default 0
    );
  `);
  await pool.query(`
    alter table users
      add constraint users_status_check
      check (status in ('ACTIVE', 'INACTIVE'));
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
      id uuid primary key,
      phone text not null,
      code text not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    );
  `);
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
    create type call_direction_enum as enum ('outbound', 'inbound');
  `);
  await pool.query(`
    create type call_status_enum as enum ('initiated', 'ringing', 'in_progress', 'connected', 'ended', 'failed', 'no_answer', 'busy', 'completed', 'canceled', 'cancelled');
  `);
  await pool.query(`
    create table if not exists call_logs (
      id uuid primary key,
      phone_number text not null,
      from_number text null,
      to_number text null,
      twilio_call_sid text null,
      direction call_direction_enum not null,
      status call_status_enum not null,
      duration_seconds integer null,
      staff_user_id uuid null references users(id) on delete set null,
      crm_contact_id uuid null,
      application_id uuid null,
      error_code text null,
      error_message text null,
      recording_sid text null,
      recording_duration_seconds integer null,
      created_at timestamptz not null default now(),
      started_at timestamptz not null default now(),
      ended_at timestamptz null,
      constraint call_logs_duration_check check (duration_seconds is null or duration_seconds >= 0),
      constraint call_logs_recording_duration_check check (
        recording_duration_seconds is null or recording_duration_seconds >= 0
      )
    );
  `);
  await pool.query(`
    create unique index if not exists call_logs_twilio_call_sid_unique
      on call_logs (twilio_call_sid)
      where twilio_call_sid is not null;
  `);
  await pool.query(`
    create table if not exists lenders (
      id uuid primary key,
      name text not null,
      active boolean not null default true,
      status text not null default 'ACTIVE',
      country text not null,
      submission_method text not null default 'email',
      submission_email text null,
      api_config jsonb null,
      submission_config jsonb null,
      google_sheet_id text null,
      google_sheet_tab text null,
      google_sheet_mapping jsonb null,
      primary_contact_name text null,
      primary_contact_email text null,
      primary_contact_phone text null,
      website text null,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
  `);

  await pool.query(`
    create table if not exists submission_events (
      id uuid primary key,
      application_id uuid not null,
      lender_id uuid not null references lenders(id) on delete cascade,
      method text not null,
      status text not null,
      internal_error text null,
      created_at timestamptz not null default now()
    );
  `);


  await pool.query(`
    create table if not exists lender_products (
      id uuid primary key,
      lender_id uuid not null references lenders(id) on delete cascade,
      name text not null,
      category text not null,
      country text not null,
      rate_type text null,
      interest_min text null,
      interest_max text null,
      term_min integer null,
      term_max integer null,
      term_unit text not null default 'MONTHS',
      active boolean not null default true,
      required_documents jsonb not null default '[]'::jsonb,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
  `);
  await pool.query(`
    create table if not exists lender_product_requirements (
      id uuid primary key,
      lender_product_id uuid not null references lender_products(id) on delete cascade,
      document_type text not null,
      required boolean not null default true,
      min_amount integer null,
      max_amount integer null,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists pwa_subscriptions (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      endpoint text not null unique,
      p256dh text not null,
      auth text not null,
      device_type text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists pwa_notifications (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      level text not null,
      title text not null,
      body text not null,
      delivered_at timestamptz not null,
      acknowledged_at timestamptz null,
      payload_hash text not null
    );
  `);

  await pool.query(
    `insert into lenders (id, name, country, submission_method, created_at, updated_at)
     values ('00000000-0000-0000-0000-00000000a001', 'Test Lender', 'US', 'api', now(), now())
     on conflict (id) do nothing`
  );
  await pool.query(
    `insert into lender_products
     (id, lender_id, name, category, country, rate_type, interest_min, interest_max, term_min, term_max, term_unit, active, required_documents, created_at, updated_at)
     values (
       '00000000-0000-0000-0000-00000000b001',
       '00000000-0000-0000-0000-00000000a001',
       'Standard LOC',
       'LOC',
       'US',
       'FIXED',
       '8.5',
       '12.5',
       6,
       24,
       'MONTHS',
       true,
       '[{"type":"bank_statement","months":6},{"type":"id_document","required":true}]'::jsonb,
       now(),
       now()
     )
     on conflict (id) do nothing`
  );
});

const twilioModule = require("twilio") as {
  __twilioMocks: unknown;
};

Object.assign(globalThis, { __twilioMocks: twilioModule.__twilioMocks });
