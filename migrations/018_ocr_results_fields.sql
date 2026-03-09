alter table if exists ocr_results
  rename to ocr_document_results;

create table if not exists ocr_results (
  id text primary key,
  application_id text not null references applications(id) on delete cascade,
  document_id text not null references documents(id) on delete cascade,
  field_key text not null,
  value text not null,
  confidence numeric not null,
  source_document_type text null,
  created_at timestamp not null
);

create index if not exists ocr_results_application_id_idx
  on ocr_results (application_id);

create index if not exists ocr_results_document_id_idx
  on ocr_results (document_id);

create index if not exists ocr_results_field_key_idx
  on ocr_results (field_key);

insert into ocr_results
  (id, application_id, document_id, field_key, value, confidence, source_document_type, created_at)
select f.id,
       f.application_id,
       f.document_id,
       f.field_key,
       f.value,
       f.confidence,
       d.document_type,
       f.created_at
from document_ocr_fields f
join documents d on d.id = f.document_id
on conflict do nothing;

alter table if exists ocr_document_results
  drop constraint if exists ocr_results_document_id_fkey,
  add constraint ocr_document_results_document_id_fkey
    foreign key (document_id) references documents(id) on delete restrict;
