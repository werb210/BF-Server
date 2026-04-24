create table if not exists chat_sessions (
  id uuid primary key default gen_random_uuid(),
  source varchar(50) not null,
  channel varchar(20) not null default 'text',
  status varchar(50) not null default 'ai',
  lead_id uuid null,
  created_at timestamp default now(),
  updated_at timestamp default now()
);

alter table if exists chat_sessions
  add column if not exists source varchar(50);

alter table if exists chat_sessions
  add column if not exists channel varchar(20) not null default 'text';

alter table if exists chat_sessions
  add column if not exists lead_id uuid null;

alter table if exists chat_sessions
  alter column status type varchar(50);

alter table if exists chat_sessions
  alter column status set default 'ai';

update chat_sessions set source = 'website' where source is null;

alter table if exists chat_sessions
  alter column source set not null;

alter table if exists chat_sessions
  drop constraint if exists chat_sessions_status_check;


update chat_sessions
set status = case
  when status in ('queued', 'live') then 'human'
  when status not in ('ai', 'human', 'closed') then 'ai'
  else status
end;

alter table if exists chat_sessions
  add constraint chat_sessions_status_check
  check (status in ('ai', 'human', 'closed'));

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references chat_sessions(id) on delete cascade,
  role varchar(20) not null,
  message text not null,
  metadata jsonb,
  created_at timestamp default now()
);

alter table if exists chat_messages
  add column if not exists message text;

alter table if exists chat_messages
  add column if not exists metadata jsonb;

alter table if exists chat_messages
  add column if not exists created_at timestamp default now();

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'chat_messages' and column_name = 'content'
  ) then
    execute 'update chat_messages set message = content where message is null and content is not null';
  end if;
end $$;

alter table if exists chat_messages
  alter column message set not null;

create table if not exists capital_readiness (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  score integer not null,
  tier varchar(50) not null,
  payload jsonb not null,
  created_at timestamp default now()
);
