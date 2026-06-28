-- BF_CONTACT_DOCUMENTS_v1
-- Files filed against a CRM contact (e.g. inbound email attachments auto-filed per silo),
-- with the bytes stored in Azure blob. The partial unique index dedupes auto-filed email
-- attachments by (silo, source_message_id, filename) so the inbound poller can re-run safely,
-- while leaving manual uploads (null source_message_id) unconstrained. Idempotent.
create table if not exists contact_documents (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete cascade,
  silo text not null default 'BF',
  filename text not null,
  content_type text,
  size_bytes bigint,
  blob_name text not null,
  blob_url text,
  source text not null default 'email',
  source_message_id text,
  created_at timestamptz not null default now()
);
create index if not exists idx_contact_documents_contact on contact_documents(contact_id);
create index if not exists idx_contact_documents_silo on contact_documents(silo);
create unique index if not exists uq_contact_documents_dedupe
  on contact_documents(silo, source_message_id, filename)
  where source_message_id is not null;
