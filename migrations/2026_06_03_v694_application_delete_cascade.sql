-- BF_SERVER_BLOCK_v694_APPLICATION_DELETE_CASCADE_v1
-- Why: DELETE /api/(portal/)applications/:id failed with 409 constraint_violation
-- for any application that had documents / submissions / OCR rows, because those
-- FKs were ON DELETE RESTRICT. Flip the whole applications->documents->(versions->
-- reviews, ocr_*) and applications->submissions->retries chain to ON DELETE CASCADE
-- so deleting an application removes its data in the correct order automatically.
-- Idempotent: each constraint is dropped (if exists) and re-added with cascade.

-- direct children of applications
alter table if exists documents
  drop constraint if exists documents_application_id_fkey,
  add constraint documents_application_id_fkey
    foreign key (application_id) references applications(id) on delete cascade;

alter table if exists lender_submissions
  drop constraint if exists lender_submissions_application_id_fkey,
  add constraint lender_submissions_application_id_fkey
    foreign key (application_id) references applications(id) on delete cascade;

alter table if exists client_submissions
  drop constraint if exists client_submissions_application_id_fkey,
  add constraint client_submissions_application_id_fkey
    foreign key (application_id) references applications(id) on delete cascade;

alter table if exists ocr_jobs
  drop constraint if exists ocr_jobs_application_id_fkey,
  add constraint ocr_jobs_application_id_fkey
    foreign key (application_id) references applications(id) on delete cascade;

-- children of documents
alter table if exists document_versions
  drop constraint if exists document_versions_document_id_fkey,
  add constraint document_versions_document_id_fkey
    foreign key (document_id) references documents(id) on delete cascade;

alter table if exists ocr_jobs
  drop constraint if exists ocr_jobs_document_id_fkey,
  add constraint ocr_jobs_document_id_fkey
    foreign key (document_id) references documents(id) on delete cascade;

alter table if exists ocr_results
  drop constraint if exists ocr_results_document_id_fkey,
  add constraint ocr_results_document_id_fkey
    foreign key (document_id) references documents(id) on delete cascade;

alter table if exists ocr_document_results
  drop constraint if exists ocr_document_results_document_id_fkey,
  add constraint ocr_document_results_document_id_fkey
    foreign key (document_id) references documents(id) on delete cascade;

-- child of document_versions
alter table if exists document_version_reviews
  drop constraint if exists document_version_reviews_document_version_id_fkey,
  add constraint document_version_reviews_document_version_id_fkey
    foreign key (document_version_id) references document_versions(id) on delete cascade;

-- child of lender_submissions
alter table if exists lender_submission_retries
  drop constraint if exists lender_submission_retries_submission_id_fkey,
  add constraint lender_submission_retries_submission_id_fkey
    foreign key (submission_id) references lender_submissions(id) on delete cascade;
