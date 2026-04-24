create table if not exists ai_escalations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid null references chat_sessions(id) on delete set null,
  messages jsonb not null,
  status text not null default 'open',
  created_at timestamp not null default now()
);

create index if not exists idx_ai_escalations_status_created_at
  on ai_escalations(status, created_at desc);
