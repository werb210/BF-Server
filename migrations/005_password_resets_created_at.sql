alter table if exists password_resets
  add column if not exists created_at timestamp not null default now();
