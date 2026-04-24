alter table if exists users
  alter column email set not null;

create unique index if not exists users_email_unique_idx
  on users (email);

create unique index if not exists idempotency_keys_key_route_unique_idx
  on idempotency_keys (key, route);

alter table if exists auth_refresh_tokens
  drop constraint if exists auth_refresh_tokens_user_id_fkey,
  add constraint auth_refresh_tokens_user_id_fkey
    foreign key (user_id) references users(id) on delete restrict;

alter table if exists password_resets
  drop constraint if exists password_resets_user_id_fkey,
  add constraint password_resets_user_id_fkey
    foreign key (user_id) references users(id) on delete restrict;

alter table if exists applications
  drop constraint if exists applications_owner_user_id_fkey,
  add constraint applications_owner_user_id_fkey
    foreign key (owner_user_id) references users(id) on delete restrict;

alter table if exists documents
  drop constraint if exists documents_application_id_fkey,
  add constraint documents_application_id_fkey
    foreign key (application_id) references applications(id) on delete restrict;

alter table if exists documents
  drop constraint if exists documents_owner_user_id_fkey,
  add constraint documents_owner_user_id_fkey
    foreign key (owner_user_id) references users(id) on delete restrict;

alter table if exists document_versions
  drop constraint if exists document_versions_document_id_fkey,
  add constraint document_versions_document_id_fkey
    foreign key (document_id) references documents(id) on delete restrict;

alter table if exists document_version_reviews
  drop constraint if exists document_version_reviews_document_version_id_fkey,
  add constraint document_version_reviews_document_version_id_fkey
    foreign key (document_version_id) references document_versions(id) on delete restrict;

alter table if exists lender_submissions
  drop constraint if exists lender_submissions_application_id_fkey,
  add constraint lender_submissions_application_id_fkey
    foreign key (application_id) references applications(id) on delete restrict;

alter table if exists client_submissions
  drop constraint if exists client_submissions_application_id_fkey,
  add constraint client_submissions_application_id_fkey
    foreign key (application_id) references applications(id) on delete restrict;

alter table if exists lender_submission_retries
  drop constraint if exists lender_submission_retries_submission_id_fkey,
  add constraint lender_submission_retries_submission_id_fkey
    foreign key (submission_id) references lender_submissions(id) on delete restrict;

alter table if exists ocr_jobs
  drop constraint if exists ocr_jobs_document_id_fkey,
  add constraint ocr_jobs_document_id_fkey
    foreign key (document_id) references documents(id) on delete restrict;

alter table if exists ocr_jobs
  drop constraint if exists ocr_jobs_application_id_fkey,
  add constraint ocr_jobs_application_id_fkey
    foreign key (application_id) references applications(id) on delete restrict;

alter table if exists ocr_results
  drop constraint if exists ocr_results_document_id_fkey,
  add constraint ocr_results_document_id_fkey
    foreign key (document_id) references documents(id) on delete restrict;

alter table if exists reporting_staff_activity_daily
  drop constraint if exists reporting_staff_activity_daily_staff_user_id_fkey,
  add constraint reporting_staff_activity_daily_staff_user_id_fkey
    foreign key (staff_user_id) references users(id) on delete restrict;
