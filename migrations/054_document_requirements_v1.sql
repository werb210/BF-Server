alter table if exists documents
  add column if not exists filename text,
  add column if not exists storage_key text,
  add column if not exists uploaded_by text not null default 'client',
  add column if not exists rejection_reason text,
  add column if not exists updated_at timestamptz not null default now();

update documents
set updated_at = coalesce(updated_at, created_at);

alter table if exists application_required_documents
  add column if not exists is_required boolean not null default true,
  alter column status set default 'missing';

alter table if exists application_required_documents
  drop constraint if exists application_required_documents_status_check;

alter table if exists application_required_documents
  add constraint application_required_documents_status_check
    check (status in ('missing', 'uploaded', 'accepted', 'rejected'));

update application_required_documents
set status = 'missing'
where status = 'required';
