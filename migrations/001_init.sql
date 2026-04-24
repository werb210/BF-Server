create table if not exists users (
  id uuid primary key,
  email text not null unique,
  password_hash text not null,
  role text not null,
  active boolean not null,
  password_changed_at timestamptz null,
  failed_login_attempts integer not null default 0,
  locked_until timestamptz null,
  token_version integer not null default 0
);

create table if not exists auth_refresh_tokens (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz null,
  created_at timestamptz not null,
  unique (user_id)
);

create table if not exists password_resets (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz null
);

create table if not exists audit_logs (
  id text primary key,
  actor_user_id uuid null references users(id) on delete set null,
  action text not null,
  entity text not null,
  entity_id text null,
  ip text null,
  success boolean not null,
  created_at timestamptz not null
);

create table if not exists audit_events (
  id text primary key,
  user_id uuid null references users(id) on delete set null,
  action text not null,
  ip text null,
  user_agent text null,
  success boolean not null,
  created_at timestamptz not null
);
