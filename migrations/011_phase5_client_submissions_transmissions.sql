create table if not exists client_submissions (
  id text primary key,
  submission_key text not null unique,
  application_id text not null references applications(id) on delete cascade,
  payload jsonb not null,
  created_at timestamp not null
);

alter table if exists lender_submissions
  add column if not exists payload_hash text null,
  add column if not exists lender_response jsonb null,
  add column if not exists response_received_at timestamp null,
  add column if not exists failure_reason text null;

create table if not exists lender_submission_retries (
  id text primary key,
  submission_id text not null references lender_submissions(id) on delete cascade,
  status text not null,
  attempt_count integer not null default 0,
  next_attempt_at timestamp null,
  last_error text null,
  created_at timestamp not null,
  updated_at timestamp not null,
  canceled_at timestamp null,
  unique (submission_id)
);

drop index if exists lender_submissions_application_id_unique;
alter table lender_submissions
  drop constraint if exists lender_submissions_idempotency_key_key;

create unique index if not exists lender_submissions_application_lender_unique
  on lender_submissions (application_id, lender_id);

create unique index if not exists lender_submissions_idempotency_key_unique
  on lender_submissions (idempotency_key)
  where idempotency_key is not null;

insert into users (id, email, password_hash, role, active, password_changed_at)
values (
  '00000000-0000-0000-0000-000000000001',
  'client-submission@system.local',
  '$2a$10$w6mUovSd.4MYgYusN4uT0.oVpi9oyaylVv4QOM4bLIKO7iHuUWLZa',
  'Referrer',
  false,
  now()
)
on conflict (id) do nothing;
