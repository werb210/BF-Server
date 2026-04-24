create table if not exists ocr_jobs (
  id text primary key,
  document_id text not null references documents(id) on delete cascade,
  application_id text not null references applications(id) on delete cascade,
  status text not null,
  attempt_count integer not null,
  max_attempts integer not null,
  next_attempt_at timestamp null,
  locked_at timestamp null,
  locked_by text null,
  last_error text null,
  created_at timestamp not null,
  updated_at timestamp not null,
  unique (document_id),
  check (status in ('queued', 'processing', 'succeeded', 'failed', 'canceled'))
);

create table if not exists ocr_results (
  id text primary key,
  document_id text not null references documents(id) on delete cascade,
  provider text not null,
  model text not null,
  extracted_text text not null,
  extracted_json jsonb null,
  meta jsonb null,
  created_at timestamp not null,
  updated_at timestamp not null,
  unique (document_id)
);

create index if not exists ocr_jobs_status_next_attempt_at_idx
  on ocr_jobs (status, next_attempt_at);

create index if not exists ocr_jobs_document_id_idx
  on ocr_jobs (document_id);

create index if not exists ocr_results_document_id_idx
  on ocr_results (document_id);
