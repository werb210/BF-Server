import { afterAll, afterEach, beforeAll } from "vitest";
import { pool } from "../db";
import { runMigrations } from "../migrations";

type TableRow = { tablename: string };

function assertTestDatabase(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Test database helpers require NODE_ENV=test.");
  }
}

async function listPublicTables(): Promise<string[]> {
  const res = await pool.query<TableRow>(
    "select table_name as tablename from information_schema.tables where table_schema = 'public'"
  );
  return res.rows.map((row) => row.tablename);
}

async function ensureColumn(params: {
  table: string;
  column: string;
  definition: string;
}): Promise<void> {
  const res = await pool.query(
    "select 1 from information_schema.columns where table_name = $1 and column_name = $2",
    [params.table, params.column]
  );
  if (res.rows.length === 0) {
    await pool.query(
      `alter table ${params.table} add column ${params.definition}`
    );
  }
}

async function ensureUserColumns(): Promise<void> {
  await ensureColumn({
    table: "users",
    column: "status",
    definition: "status text",
  });
  await ensureColumn({
    table: "users",
    column: "phone_verified",
    definition: "phone_verified boolean not null default false",
  });
  await ensureColumn({
    table: "users",
    column: "silo",
    definition: "silo text",
  });
  await ensureColumn({
    table: "users",
    column: "is_active",
    definition: "is_active boolean",
  });
  await ensureColumn({
    table: "users",
    column: "disabled",
    definition: "disabled boolean",
  });
  await ensureColumn({
    table: "users",
    column: "phone",
    definition: "phone text",
  });
  await ensureColumn({
    table: "users",
    column: "last_login_at",
    definition: "last_login_at timestamptz",
  });
  await ensureColumn({
    table: "users",
    column: "locked_until",
    definition: "locked_until timestamptz",
  });
  await ensureColumn({
    table: "users",
    column: "token_version",
    definition: "token_version integer not null default 0",
  });
}

async function ensureAuthRefreshTokenColumns(): Promise<void> {
  await ensureColumn({
    table: "auth_refresh_tokens",
    column: "token",
    definition: "token text",
  });
  await ensureColumn({
    table: "auth_refresh_tokens",
    column: "token_hash",
    definition: "token_hash text",
  });
  await ensureColumn({
    table: "auth_refresh_tokens",
    column: "revoked_at",
    definition: "revoked_at timestamptz",
  });
  await ensureColumn({
    table: "auth_refresh_tokens",
    column: "expires_at",
    definition: "expires_at timestamptz",
  });
  await ensureColumn({
    table: "auth_refresh_tokens",
    column: "created_at",
    definition: "created_at timestamptz",
  });
  try {
    await pool.query(
      "alter table auth_refresh_tokens drop constraint auth_refresh_tokens_user_id_key"
    );
  } catch {
    // ignore if constraint does not exist in test schema
  }
  try {
    await pool.query("drop index auth_refresh_tokens_user_id_key");
  } catch {
    // ignore if index does not exist in test schema
  }
}

async function truncateAllTables(): Promise<void> {
  const tables = await listPublicTables();
  const filtered = tables.filter((name) => name !== "schema_migrations");
  if (filtered.length === 0) {
    return;
  }
  for (const table of filtered) {
    await pool.query(`truncate table "${table}" restart identity cascade`);
  }
}

async function ensureTable(table: string, createSql: string): Promise<void> {
  const res = await pool.query(
    "select 1 from information_schema.tables where table_name = $1 and table_schema = 'public'",
    [table]
  );
  if (res.rows.length === 0) {
    await pool.query(createSql);
  }
}

async function ensureCoreTables(): Promise<void> {
  await ensureTable(
    "audit_events",
    `create table audit_events (
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
      metadata jsonb null
    )`
  );
  await ensureTable(
    "otp_verifications",
    `create table otp_verifications (
      id uuid primary key,
      user_id uuid not null,
      phone text not null,
      status text not null,
      verified_at timestamptz null,
      created_at timestamptz not null default now()
    )`
  );
  await ensureTable(
    "idempotency_keys",
    `create table idempotency_keys (
      id uuid primary key,
      key text not null,
      route text not null,
      method text null,
      request_hash text null,
      response_code integer not null,
      response_body jsonb null,
      created_at timestamptz not null default now()
    )`
  );
  await ensureTable(
    "ocr_jobs",
    `create table ocr_jobs (
      id uuid primary key,
      document_id uuid not null,
      application_id uuid not null,
      status text not null,
      attempt_count integer not null default 0,
      max_attempts integer not null,
      next_attempt_at timestamptz null,
      locked_at timestamptz null,
      locked_by text null,
      last_error text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (document_id)
    )`
  );
}

async function ensureAuditViews(): Promise<void> {
  await pool.query(
    `create or replace view application_pipeline_history as
     select
       ase.application_id,
       ase.from_stage,
       ase.to_stage,
       ase.trigger,
       ase.triggered_by as actor_id,
       u.role as actor_role,
       case
         when ase.triggered_by = 'system' then 'system'
         when u.role in ('ADMIN', 'STAFF') then 'staff'
         else 'system'
       end as actor_type,
       ase.created_at as occurred_at,
       ase.reason as reason
     from application_stage_events ase
     left join users u on u.id::text = ase.triggered_by`
  );
  await pool.query(
    `create or replace view application_pipeline_history_view as
     select * from application_pipeline_history`
  );
  await pool.query(
    `create or replace view document_status_history as
     select
       d.application_id,
       d.id as document_id,
       d.document_type,
       null::text as actor_id,
       d.uploaded_by as actor_role,
       case when d.uploaded_by = 'staff' then 'staff' else 'system' end as actor_type,
       null::text as previous_status,
       d.status as next_status,
       d.rejection_reason as reason,
       d.created_at as occurred_at
     from documents d
     union all
     select
       d.application_id,
       d.id as document_id,
       d.document_type,
       r.reviewed_by_user_id::text as actor_id,
       u.role as actor_role,
       case
         when u.role in ('ADMIN', 'STAFF') then 'staff'
         else 'system'
       end as actor_type,
       'uploaded' as previous_status,
       r.status as next_status,
       d.rejection_reason as reason,
       r.reviewed_at as occurred_at
     from document_version_reviews r
     join document_versions dv on dv.id = r.document_version_id
     join documents d on d.id = dv.document_id
     left join users u on u.id = r.reviewed_by_user_id`
  );
  await pool.query(
    `create or replace view document_status_history_view as
     select * from document_status_history`
  );
  try {
    await pool.query(
      `create or replace view processing_job_history as
       select
         id as job_id,
         'ocr'::text as job_type,
         application_id,
         document_id,
         null::text as previous_status,
         status as next_status,
         error_message as reason,
         retry_count,
         last_retry_at,
         coalesce(updated_at, created_at) as occurred_at,
         'system'::text as actor_type,
         null::text as actor_id
       from document_processing_jobs
       union all
       select
         id as job_id,
         'banking'::text as job_type,
         application_id,
         null::text as document_id,
         null::text as previous_status,
         status as next_status,
         error_message as reason,
         retry_count,
         last_retry_at,
         coalesce(updated_at, created_at) as occurred_at,
         'system'::text as actor_type,
         null::text as actor_id
       from banking_analysis_jobs
       union all
       select
         id as job_id,
         'credit_summary'::text as job_type,
         application_id,
         null::text as document_id,
         null::text as previous_status,
         status as next_status,
         error_message as reason,
         retry_count,
         last_retry_at,
         coalesce(updated_at, created_at) as occurred_at,
         'system'::text as actor_type,
         null::text as actor_id
       from credit_summary_jobs`
    );
  } catch {
    await pool.query(
      `create or replace view processing_job_history as
       select
         null::uuid as job_id,
         null::text as job_type,
         null::uuid as application_id,
         null::uuid as document_id,
         null::text as previous_status,
         null::text as next_status,
         null::text as reason,
         null::integer as retry_count,
         null::timestamptz as last_retry_at,
         null::timestamptz as occurred_at,
         null::text as actor_type,
         null::text as actor_id
       where false`
    );
  }
  await pool.query(
    `create or replace view processing_job_history_view as
     select * from processing_job_history`
  );
}

export function setupTestDatabase(): void {
  beforeAll(async () => {
    assertTestDatabase();
    await runMigrations({
      ignoreMissingRelations: true,
      skipPlpgsql: true,
      rewriteAlterIfExists: true,
      rewriteCreateTableIfNotExists: true,
      skipPgMemErrors: true,
    });
    await ensureUserColumns();
    await ensureAuthRefreshTokenColumns();
    await ensureCoreTables();
    await ensureAuditViews();
  });

  afterEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await pool.end();
  });
}
