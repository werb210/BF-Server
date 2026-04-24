create table if not exists communications_messages (
  id uuid primary key,
  type text,
  direction text,
  status text,
  contact_id uuid,
  body text,
  created_at timestamp default now()
);

alter table if exists application_continuations
  alter column token type text using token::text;
