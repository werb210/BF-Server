-- BF_SERVER_BLOCK_v695_QUICK_CALL_v1 — per-user dialer quick-call slots.
-- Stores up to 3 staff user ids each operator pins to their dialer quick-call buttons.
alter table if exists users
  add column if not exists quick_call_slots jsonb not null default '[]'::jsonb;
