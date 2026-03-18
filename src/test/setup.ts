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
      token_version integer not null default 0
    );
  `);
  await pool.query(`create table if not exists applications (id uuid primary key, user_id uuid null references users(id) on delete set null, created_at timestamptz not null default now());`);
  await pool.query(`create table if not exists reports (id uuid primary key, user_id uuid null references users(id) on delete set null, created_at timestamptz not null default now());`);
  await pool.query(`create table if not exists voice_logs (id uuid primary key, user_id uuid null references users(id) on delete set null, created_at timestamptz not null default now());`);

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
});

Object.assign(globalThis, { __twilioMocks: twilioMockState });
