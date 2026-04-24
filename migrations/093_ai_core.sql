-- Renamed from 2026_ai_core.sql into sequential numbering.
-- Original intent: sets up AI session tables and vector extension.

create extension if not exists vector;

create table if not exists ai_sessions (
  id uuid primary key default gen_random_uuid(),
  source varchar(20) not null,
  status varchar(20) not null default 'ai',
  contact_id uuid null,
  created_at timestamp default now(),
  closed_at timestamp null
);

create table if not exists ai_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references ai_sessions(id) on delete cascade,
  role varchar(20) not null,
  content text not null,
  metadata jsonb,
  created_at timestamp default now()
);

create table if not exists ai_knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  source_type varchar(50),
  content text not null,
  embedding vector(1536),
  updated_at timestamp default now()
);

create table if not exists ai_issues (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references ai_sessions(id),
  message text,
  screenshot text,
  page_url text,
  resolved boolean default false,
  created_at timestamp default now()
);

create table if not exists ai_rules (
  id uuid primary key default gen_random_uuid(),
  rule_key varchar(100) unique,
  rule_value text,
  updated_at timestamp default now()
);
