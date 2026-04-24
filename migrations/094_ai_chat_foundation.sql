-- Renamed from 2026_ai_chat_foundation.sql into sequential numbering.
-- Original intent: foundational chat session/message schema for AI workflows.

create extension if not exists vector;

create table if not exists chat_sessions (
  id uuid primary key,
  crm_contact_id uuid null,
  source text not null,
  status text not null default 'ai',
  assigned_to uuid null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table if exists chat_sessions add column if not exists crm_contact_id uuid null;
alter table if exists chat_sessions add column if not exists source text;
alter table if exists chat_sessions add column if not exists assigned_to uuid null;
alter table if exists chat_sessions alter column source set default 'website';
update chat_sessions set source = 'website' where source is null;
alter table if exists chat_sessions alter column source set not null;

alter table if exists chat_sessions drop constraint if exists chat_sessions_status_check;
alter table if exists chat_sessions alter column status drop default;
alter table if exists chat_sessions alter column status set default 'ai';
alter table if exists chat_sessions
  add constraint chat_sessions_status_check
  check (status in ('ai', 'queued', 'live', 'closed'));

create table if not exists chat_messages (
  id uuid primary key,
  session_id uuid references chat_sessions(id) on delete cascade,
  role text not null,
  content text not null,
  metadata jsonb null,
  created_at timestamptz default now()
);

alter table if exists chat_messages add column if not exists content text;
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'chat_messages' and column_name = 'message'
  ) then
    execute 'update chat_messages set content = message where content is null and message is not null';
  end if;
end$$;
alter table if exists chat_messages alter column content set not null;

create table if not exists chat_queue (
  id uuid primary key,
  session_id uuid references chat_sessions(id),
  priority int default 1,
  created_at timestamptz default now()
);

create table if not exists ai_knowledge (
  id uuid primary key,
  title text,
  content text not null,
  source_type text not null,
  embedding vector(1536),
  created_at timestamptz default now()
);

create table if not exists ai_policy_rules (
  id uuid primary key,
  rule_key text unique,
  rule_type text not null,
  content text not null,
  active boolean default true,
  created_at timestamptz default now()
);

create table if not exists ai_voice_state (
  session_id uuid primary key,
  state text not null,
  last_event jsonb,
  updated_at timestamptz default now()
);

insert into ai_policy_rules (id, rule_key, rule_type, content)
values
(gen_random_uuid(), 'no_lender_names', 'hard_constraint',
'Never disclose or imply the name of any specific lender.'),
(gen_random_uuid(), 'range_only', 'hard_constraint',
'All pricing, rates, and limits must be given as ranges only.'),
(gen_random_uuid(), 'underwriting_language', 'hard_constraint',
'Always include "subject to underwriting" when discussing approval.')
on conflict (rule_key) do nothing;
