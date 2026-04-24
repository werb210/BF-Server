create table if not exists ai_rules (
  id uuid primary key default gen_random_uuid(),
  rule_type text not null default 'system',
  rule_content text not null,
  priority integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists ai_rules
  add column if not exists rule_key text,
  add column if not exists rule_value text,
  add column if not exists rule_type text,
  add column if not exists rule_content text,
  add column if not exists priority integer,
  add column if not exists active boolean,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

update ai_rules
set rule_type = case
      when rule_type is not null and rule_type <> '' then rule_type
      when rule_key is not null and rule_key <> '' then rule_key
      else 'system'
    end,
    rule_content = case
      when rule_content is not null and rule_content <> '' then rule_content
      else coalesce(rule_value, '')
    end,
    priority = coalesce(priority, 100),
    active = coalesce(active, true),
    updated_at = now();

update ai_rules
set rule_content = 'legacy_rule'
where rule_content is null or rule_content = '';

alter table if exists ai_rules
  alter column rule_type set not null,
  alter column rule_content set not null,
  alter column priority set not null,
  alter column priority set default 100,
  alter column active set not null,
  alter column active set default true;

create index if not exists ai_rules_active_priority_idx on ai_rules (active, priority desc);
