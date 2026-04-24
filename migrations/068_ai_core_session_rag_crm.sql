create extension if not exists vector;

alter table if exists ai_sessions
  add column if not exists visitor_id text,
  add column if not exists context text,
  add column if not exists company_name text,
  add column if not exists full_name text,
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists application_token text,
  add column if not exists startup_interest_tags jsonb not null default '[]'::jsonb;

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'ai_sessions'
  ) then
    update ai_sessions
    set visitor_id = coalesce(visitor_id, id::text),
        context = coalesce(context, source)
    where visitor_id is null or context is null;
  end if;
end$$;

alter table if exists ai_sessions
  alter column visitor_id set not null,
  alter column context set not null;

alter table if exists ai_sessions
  alter column status set default 'active';

create table if not exists ai_embeddings (
  id uuid primary key,
  source_type text not null,
  source_id text,
  content text not null,
  embedding vector(1536)
);

create table if not exists application_continuations (
  token uuid primary key,
  prefill_json jsonb not null,
  status text not null default 'draft',
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_embeddings_source_type on ai_embeddings(source_type);
create index if not exists idx_ai_messages_session_created_at on ai_messages(session_id, created_at);
