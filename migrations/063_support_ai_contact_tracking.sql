create table if not exists live_chat_requests (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('website', 'client')),
  session_id text not null,
  status text not null default 'pending' check (status in ('pending', 'active', 'closed')),
  created_at timestamp not null default now()
);

create table if not exists contact_leads (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text not null,
  created_at timestamp not null default now()
);

alter table if exists ai_knowledge
  alter column content set not null;

alter table if exists issue_reports
  add column if not exists screenshot_base64 text null;

alter table if exists issue_reports
  add column if not exists user_agent text null;

create index if not exists idx_live_chat_requests_status_created_at
  on live_chat_requests(status, created_at desc);

create index if not exists idx_contact_leads_created_at
  on contact_leads(created_at desc);
