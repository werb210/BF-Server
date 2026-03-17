import { vi } from "vitest"
import { pool } from "../db"
import {
  getExpectedTwilioSignature,
  twilioDefaultExport,
  twilioMockState,
  validateExpressRequest,
  validateRequest,
} from "../test/twilioMock";

vi.mock("twilio", () => {
  return {
    default: twilioDefaultExport,
    validateRequest,
    validateExpressRequest,
    getExpectedTwilioSignature,
    __twilioMocks: twilioMockState,
  }
})

Object.assign(globalThis, { __twilioMocks: twilioMockState });

process.env.NODE_ENV = "test";
process.env.TWILIO_ACCOUNT_SID ??= "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env.TWILIO_AUTH_TOKEN ??= "test-auth-token-1234567890";
process.env.TWILIO_VERIFY_SERVICE_SID ??= "VA00000000000000000000000000000000";
process.env.TWILIO_API_KEY ??= "SKXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env.TWILIO_API_SECRET ??= "test-twilio-api-secret";
process.env.TWILIO_VOICE_APP_SID ??= "AP00000000000000000000000000000000";
process.env.TWILIO_VOICE_CALLER_ID ??= "+14155550000";
process.env.JWT_SECRET ??= "test-access-secret";
process.env.TEST_OTP_CODE ??= "123456";

beforeAll(async () => {
  await pool.query(`
    create table if not exists users (
      id uuid primary key,
      phone text,
      phone_number text unique,
      email text,
      role text,
      silo text,
      status text not null default 'ACTIVE',
      active boolean not null default true,
      is_active boolean,
      disabled boolean,
      locked_until timestamptz,
      phone_verified boolean not null default false,
      token_version integer not null default 0,
      created_at timestamptz not null default now()
    );
  `)

  await pool.query(`
    create table if not exists auth_refresh_tokens (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      token text not null,
      token_hash text,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      revoked boolean not null default false,
      revoked_at timestamptz
    );
  `)



  await pool.query(`
    create table if not exists otp_sessions (
      id uuid primary key,
      phone text not null,
      code text not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    );
  `)

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
  `)

  await pool.query(`
    create table if not exists audit_events (
      actor_user_id uuid,
      target_user_id uuid,
      target_type text,
      target_id text,
      event_type text not null,
      event_action text not null,
      ip_address text,
      user_agent text,
      request_id text,
      success boolean not null,
      metadata jsonb,
      created_at timestamptz not null default now()
    );
  `)

  await pool.query(`
    create table if not exists lenders (
      id uuid primary key,
      name text not null,
      active boolean not null default true,
      status text not null default 'ACTIVE',
      country text not null,
      submission_method text not null default 'email',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `)
})
