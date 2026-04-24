alter table if exists audit_events
  add column if not exists actor_user_id uuid null references users(id) on delete set null;

alter table if exists audit_events
  add column if not exists target_user_id uuid null references users(id) on delete set null;

update audit_events
set actor_user_id = coalesce(actor_user_id, user_id),
    target_user_id = coalesce(target_user_id, user_id)
where user_id is not null
  and (actor_user_id is null or target_user_id is null);
