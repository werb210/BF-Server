create extension if not exists vector;

create table if not exists ai_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  embedding vector(1536),
  source_type text not null,
  created_at timestamp default now()
);

create table if not exists ai_system_rules (
  id uuid primary key default gen_random_uuid(),
  rule_key text unique not null,
  rule_value text not null,
  updated_at timestamp default now()
);
