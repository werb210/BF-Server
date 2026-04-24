alter table if exists lenders
  drop constraint if exists lenders_submission_method_check;

alter table if exists lenders
  add constraint lenders_submission_method_check
  check (
    submission_method is null
    or submission_method in ('EMAIL', 'API', 'PORTAL', 'email', 'api', 'portal')
  );
