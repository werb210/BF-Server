alter table if exists document_versions
  add column if not exists blob_name text;

alter table if exists document_versions
  add column if not exists hash text;

create index if not exists idx_document_versions_document
  on document_versions(document_id);
