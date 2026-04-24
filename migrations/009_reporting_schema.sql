alter table if exists audit_events
  add column if not exists target_type text null;

alter table if exists audit_events
  add column if not exists target_id text null;

create table if not exists reporting_daily_metrics (
  id text primary key,
  metric_date date not null unique,
  applications_created integer not null,
  applications_submitted integer not null,
  applications_approved integer not null,
  applications_declined integer not null,
  applications_funded integer not null,
  documents_uploaded integer not null,
  documents_approved integer not null,
  lender_submissions integer not null,
  created_at timestamp not null
);

create table if not exists reporting_pipeline_snapshots (
  id text primary key,
  snapshot_at timestamp not null,
  pipeline_state text not null,
  application_count integer not null,
  unique (snapshot_at, pipeline_state)
);

create table if not exists reporting_lender_performance (
  id text primary key,
  lender_id text not null,
  period_start date not null,
  period_end date not null,
  submissions integer not null,
  approvals integer not null,
  declines integer not null,
  funded integer not null,
  avg_decision_time_seconds integer not null,
  created_at timestamp not null,
  unique (lender_id, period_start, period_end)
);

create unique index if not exists reporting_lender_performance_unique_idx
  on reporting_lender_performance (lender_id, period_start, period_end);

create index if not exists applications_created_at_idx
  on applications (created_at);

create index if not exists applications_pipeline_updated_idx
  on applications (pipeline_state, updated_at);

create index if not exists documents_created_at_idx
  on documents (created_at);

create index if not exists document_versions_created_at_idx
  on document_versions (created_at);

create index if not exists document_version_reviews_status_reviewed_idx
  on document_version_reviews (status, reviewed_at);

create index if not exists lender_submissions_submitted_at_idx
  on lender_submissions (submitted_at);

create index if not exists lender_submissions_lender_submitted_idx
  on lender_submissions (lender_id, submitted_at);

create index if not exists lender_submissions_created_at_idx
  on lender_submissions (created_at);

create index if not exists lender_submissions_lender_created_idx
  on lender_submissions (lender_id, created_at);

create index if not exists reporting_daily_metrics_metric_date_idx
  on reporting_daily_metrics (metric_date);

create index if not exists reporting_pipeline_snapshots_snapshot_idx
  on reporting_pipeline_snapshots (snapshot_at, pipeline_state);

create index if not exists reporting_lender_performance_period_idx
  on reporting_lender_performance (lender_id, period_start, period_end);

create or replace view vw_pipeline_current_state as
select
  pipeline_state,
  count(*)::int as application_count
from applications
group by pipeline_state;

create or replace view vw_application_conversion_funnel as
select
  count(*)::int as applications_created,
  count(*) filter (where pipeline_state = 'LENDER_SUBMITTED')::int as applications_submitted,
  count(*) filter (where pipeline_state = 'APPROVED')::int as applications_approved,
  count(*) filter (where pipeline_state = 'FUNDED')::int as applications_funded
from applications;

create or replace view vw_document_processing_stats as
select
  count(dv.id)::int as documents_uploaded,
  count(r.id)::int as documents_reviewed,
  count(*) filter (where r.status = 'accepted')::int as documents_approved,
  case
    when count(r.id) = 0 then 0
    else count(*) filter (where r.status = 'accepted')::numeric / count(r.id)::numeric
  end as approval_rate
from document_versions dv
left join document_version_reviews r on r.document_version_id = dv.id;

create or replace view vw_lender_conversion as
select
  ls.lender_id,
  count(*)::int as submissions,
  count(*) filter (where a.pipeline_state = 'APPROVED')::int as approvals,
  count(*) filter (where a.pipeline_state = 'DECLINED')::int as declines,
  count(*) filter (where a.pipeline_state = 'FUNDED')::int as funded,
  case
    when count(*) = 0 then 0
    else count(*) filter (where a.pipeline_state = 'APPROVED')::numeric / count(*)::numeric
  end as approval_rate,
  case
    when count(*) = 0 then 0
    else count(*) filter (where a.pipeline_state = 'FUNDED')::numeric / count(*)::numeric
  end as funding_rate
from lender_submissions ls
join applications a on a.id = ls.application_id
group by ls.lender_id;
