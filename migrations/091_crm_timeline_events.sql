create table if not exists crm_timeline_events (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete cascade,
  application_id uuid null references applications(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}',
  actor_user_id uuid null references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists crm_timeline_contact_idx on crm_timeline_events (contact_id, created_at desc);
create index if not exists crm_timeline_application_idx on crm_timeline_events (application_id, created_at desc);
create index if not exists crm_timeline_event_type_idx on crm_timeline_events (event_type);
