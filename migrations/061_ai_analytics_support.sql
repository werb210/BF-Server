create table if not exists ai_knowledge (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  source_type text not null check (source_type in ('spec_sheet', 'faq', 'internal', 'product')),
  created_at timestamp not null default now()
);

create table if not exists analytics_events (
  id uuid primary key default gen_random_uuid(),
  event text not null,
  metadata jsonb not null default '{}'::jsonb,
  ip text null,
  user_agent text null,
  created_at timestamp not null default now()
);

create index if not exists idx_ai_knowledge_source_type on ai_knowledge(source_type);
create index if not exists idx_analytics_events_event_created_at on analytics_events(event, created_at desc);
