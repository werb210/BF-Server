create table if not exists voicemails (
  id uuid primary key,
  client_id uuid null,
  call_sid text not null,
  recording_sid text not null,
  recording_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists voicemails_call_sid_idx on voicemails(call_sid);
create index if not exists voicemails_client_id_idx on voicemails(client_id);
