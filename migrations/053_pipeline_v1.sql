alter table if exists applications
  add column if not exists company_id uuid,
  add column if not exists contact_id uuid,
  add column if not exists product_category text,
  add column if not exists current_stage text,
  add column if not exists first_opened_at timestamptz,
  add column if not exists startup_flag boolean not null default false;

update applications
set product_category = coalesce(product_category, product_type),
    current_stage = coalesce(current_stage, pipeline_state),
    startup_flag = coalesce(startup_flag, lower(coalesce(product_category, product_type, '')) = 'startup');

create table if not exists application_stage_events (
  id uuid primary key,
  application_id text not null references applications(id) on delete cascade,
  from_stage text null,
  to_stage text not null,
  trigger text not null,
  triggered_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists application_stage_events_application_id_idx
  on application_stage_events (application_id);

create table if not exists application_required_documents (
  id uuid primary key,
  application_id text not null references applications(id) on delete cascade,
  document_category text not null,
  status text not null,
  created_at timestamptz not null default now(),
  constraint application_required_documents_status_check
    check (status in ('required', 'uploaded', 'accepted', 'rejected')),
  unique (application_id, document_category)
);
