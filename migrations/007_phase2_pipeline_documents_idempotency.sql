alter table if exists applications
  add column if not exists product_type text not null default 'standard';

update applications
set pipeline_state = case pipeline_state
  when 'new' then 'NEW'
  when 'requires_docs' then 'REQUIRES_DOCS'
  when 'under_review' then 'UNDER_REVIEW'
  when 'submitted' then 'LENDER_SUBMITTED'
  when 'approved' then 'APPROVED'
  when 'declined' then 'DECLINED'
  when 'funded' then 'FUNDED'
  else pipeline_state
end;

alter table if exists documents
  add column if not exists document_type text not null default 'general';

create table if not exists document_version_reviews (
  id text primary key,
  document_version_id text not null references document_versions(id) on delete cascade,
  status text not null,
  reviewed_by_user_id uuid null references users(id) on delete set null,
  reviewed_at timestamp not null,
  unique (document_version_id)
);

create table if not exists idempotency_keys (
  id text primary key,
  actor_user_id uuid not null references users(id) on delete cascade,
  scope text not null,
  idempotency_key text not null,
  status_code integer not null,
  response_body jsonb not null,
  created_at timestamp not null,
  unique (actor_user_id, scope, idempotency_key)
);

alter table if exists lender_submissions
  add column if not exists lender_id text not null default 'default',
  add column if not exists submitted_at timestamp null,
  add column if not exists payload jsonb null;

alter table if exists lender_submissions
  alter column idempotency_key drop not null;

create unique index if not exists lender_submissions_application_id_unique
  on lender_submissions (application_id);
