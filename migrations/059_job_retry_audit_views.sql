alter table if exists application_stage_events
  add column if not exists reason text;

create table if not exists circuit_breaker_state (
  name text primary key,
  state text not null check (state in ('CLOSED', 'OPEN', 'HALF_OPEN')),
  failures integer not null default 0,
  opened_at timestamptz,
  updated_at timestamptz not null default now()
);

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
  ase.reason as reason
from application_stage_events ase
left join users u on u.id::text = ase.triggered_by;

create or replace view application_pipeline_history as
select *
from application_pipeline_history_view;

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
left join users u on u.id = r.reviewed_by_user_id;

create or replace view document_status_history as
select *
from document_status_history_view;

create or replace view processing_job_history_view as
select
  id::text as job_id,
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
  id::text as job_id,
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
  id::text as job_id,
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
from credit_summary_jobs
union all
select
  ae.target_id as job_id,
  coalesce(dp.job_type, case when ba.id is not null then 'banking' else null end,
           case when cs.id is not null then 'credit_summary' else null end,
           ae.metadata->>'jobType') as job_type,
  coalesce(dp.application_id, ba.application_id, cs.application_id) as application_id,
  dp.document_id::text,
  'failed'::text as previous_status,
  'pending'::text as next_status,
  ae.metadata->>'reason' as reason,
  coalesce(dp.retry_count, ba.retry_count, cs.retry_count) as retry_count,
  coalesce(dp.last_retry_at, ba.last_retry_at, cs.last_retry_at) as last_retry_at,
  ae.created_at as occurred_at,
  case
    when u.role in ('ADMIN', 'STAFF') then 'staff'
    else 'system'
  end as actor_type,
  ae.actor_user_id::text as actor_id
from audit_events ae
left join document_processing_jobs dp on dp.id::text = ae.target_id
left join banking_analysis_jobs ba on ba.id::text = ae.target_id
left join credit_summary_jobs cs on cs.id::text = ae.target_id
left join users u on u.id = ae.actor_user_id
where ae.target_type = 'processing_job'
  and ae.event_action = 'processing_job_retried';

create or replace view processing_job_history as
select *
from processing_job_history_view;
