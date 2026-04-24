-- Renamed from 2026_knowledge.sql into sequential numbering.
-- Original intent: establishes AI knowledge base storage and embeddings.

create extension if not exists vector;

create table if not exists ai_knowledge (
  id uuid primary key,
  source_type text not null,
  source_id text,
  content text not null,
  embedding vector(1536),
  created_at timestamp default now()
);

alter table if exists ai_knowledge
  add column if not exists source_id text,
  add column if not exists embedding vector(1536);
