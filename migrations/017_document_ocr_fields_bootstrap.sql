create table if not exists document_ocr_fields (
  id text primary key,
  document_id text not null references documents(id) on delete cascade,
  application_id text not null references applications(id) on delete cascade,
  field_key text not null,
  value text not null,
  confidence numeric not null,
  page integer null,
  created_at timestamptz not null default now()
);

create index if not exists document_ocr_fields_application_id_idx
  on document_ocr_fields (application_id);

create index if not exists document_ocr_fields_document_id_idx
  on document_ocr_fields (document_id);
