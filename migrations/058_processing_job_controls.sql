alter table if exists document_processing_jobs
  add column if not exists job_type text not null default 'ocr',
  add column if not exists started_at timestamptz,
  add column if not exists error_message text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists retry_count integer not null default 0,
  add column if not exists last_retry_at timestamptz,
  add column if not exists max_retries integer not null default 3;

update document_processing_jobs
set job_type = coalesce(job_type, 'ocr'),
    updated_at = coalesce(updated_at, created_at);

alter table if exists document_processing_jobs
  drop constraint if exists document_processing_jobs_status_check;

alter table if exists document_processing_jobs
  add constraint document_processing_jobs_status_check
    check (status in ('pending', 'processing', 'completed', 'failed'));

create unique index if not exists document_processing_jobs_document_id_job_type_idx
  on document_processing_jobs (document_id, job_type);

alter table if exists banking_analysis_jobs
  add column if not exists started_at timestamptz,
  add column if not exists error_message text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists retry_count integer not null default 0,
  add column if not exists last_retry_at timestamptz,
  add column if not exists max_retries integer not null default 2;

update banking_analysis_jobs
set updated_at = coalesce(updated_at, created_at);

alter table if exists banking_analysis_jobs
  drop constraint if exists banking_analysis_jobs_status_check;

alter table if exists banking_analysis_jobs
  add constraint banking_analysis_jobs_status_check
    check (status in ('pending', 'processing', 'completed', 'failed'));

create table if not exists credit_summary_jobs (
  id uuid primary key,
  application_id text not null references applications(id) on delete cascade,
  status text not null check (status in ('pending', 'processing', 'completed', 'failed')),
  retry_count integer not null default 0,
  last_retry_at timestamptz,
  max_retries integer not null default 1,
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists credit_summary_jobs_application_id_idx
  on credit_summary_jobs (application_id);

create or replace view application_pipeline_history_view as
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
  null::text as failure_reason
from application_stage_events ase
left join users u on u.id::text = ase.triggered_by;

create or replace view document_status_history_view as
select
  d.application_id,
  d.id as document_id,
  d.document_type,
  null::text as actor_id,
  d.uploaded_by as actor_role,
  case when d.uploaded_by = 'staff' then 'staff' else 'system' end as actor_type,
  null::text as previous_status,
  d.status as next_status,
  d.rejection_reason as failure_reason,
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
  d.rejection_reason as failure_reason,
  r.reviewed_at as occurred_at
from document_version_reviews r
join document_versions dv on dv.id = r.document_version_id
join documents d on d.id = dv.document_id
left join users u on u.id = r.reviewed_by_user_id;

create or replace view processing_job_history_view as
select
  id as job_id,
  'ocr'::text as job_type,
  application_id,
  document_id,
  null::text as previous_status,
  status as next_status,
  error_message,
  retry_count,
  last_retry_at,
  coalesce(updated_at, created_at) as occurred_at
from document_processing_jobs
union all
select
  id as job_id,
  'banking'::text as job_type,
  application_id,
  null::text as document_id,
  null::text as previous_status,
  status as next_status,
  error_message,
  retry_count,
  last_retry_at,
  coalesce(updated_at, created_at) as occurred_at
from banking_analysis_jobs
union all
select
  id as job_id,
  'credit_summary'::text as job_type,
  application_id,
  null::text as document_id,
  null::text as previous_status,
  status as next_status,
  error_message,
  retry_count,
  last_retry_at,
  coalesce(updated_at, created_at) as occurred_at
from credit_summary_jobs;
