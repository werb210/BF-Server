alter table if exists lenders
  add column if not exists submission_method text not null default 'email',
  add column if not exists submission_config jsonb null;

-- These normalisation UPDATEs only make sense when submission_method is still
-- text; if it was converted to an enum by an earlier migration the values are
-- already valid enum labels and assigning plain text back to the enum column
-- fails. Skip when the column is already an enum — the ALTER COLUMN TYPE
-- below will handle the conversion and normalisation via its USING clause.
DO $$
DECLARE col_type text;
BEGIN
  SELECT udt_name INTO col_type
  FROM information_schema.columns
  WHERE table_name = 'lenders' AND column_name = 'submission_method';
  IF col_type = 'text' THEN
    UPDATE lenders
    SET submission_method = lower(submission_method)
    WHERE submission_method IS NOT NULL;

    UPDATE lenders
    SET submission_method = 'email'
    WHERE submission_method IS NULL;
  END IF;
END $$;

-- Drop any pre-existing submission_method CHECK constraint BEFORE the
-- ALTER COLUMN TYPE below. Postgres revalidates CHECK constraints when the
-- column type changes, and an old constraint requiring uppercase values
-- (from migration 042) will reject the lowercased values produced by the
-- USING clause.
alter table if exists lenders
  drop constraint if exists lenders_submission_method_check;

alter table if exists lenders
  alter column submission_method type text using lower(submission_method::text),
  alter column submission_method set default 'email',
  alter column submission_method set not null;

alter table if exists lenders
  add constraint lenders_submission_method_check
  check (submission_method in ('email', 'api', 'google_sheet'));

-- BF_SERVER_MIGRATION_050_LENDER_ID_TYPE_v1
do $submission_events$
declare app_id_type text; lender_id_type text;
begin
  select atttypid::regtype::text into app_id_type from pg_attribute
    where attrelid = 'public.applications'::regclass and attname = 'id' and not attisdropped;
  select atttypid::regtype::text into lender_id_type from pg_attribute
    where attrelid = 'public.lenders'::regclass and attname = 'id' and not attisdropped;
  execute format($ddl$
    create table if not exists submission_events (
      id uuid primary key,
      application_id %s not null references applications(id) on delete cascade,
      lender_id %s not null references lenders(id) on delete cascade,
      method text not null,
      status text not null,
      internal_error text null,
      created_at timestamp not null default now()
    )
  $ddl$, coalesce(app_id_type, 'text'), coalesce(lender_id_type, 'uuid'));
end
$submission_events$;
