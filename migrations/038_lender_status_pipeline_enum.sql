DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lender_status') THEN
    CREATE TYPE lender_status AS ENUM ('ACTIVE', 'INACTIVE');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'lenders'
      AND column_name = 'status'
  ) THEN
    ALTER TABLE lenders
      ADD COLUMN status lender_status;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'lenders'
      AND column_name = 'status'
      AND udt_name <> 'lender_status'
  ) THEN
    ALTER TABLE lenders
      ALTER COLUMN status TYPE lender_status
      USING (
        CASE
          WHEN status IS NULL THEN 'ACTIVE'::lender_status
          WHEN LOWER(status::text) = 'inactive' THEN 'INACTIVE'::lender_status
          ELSE 'ACTIVE'::lender_status
        END
      );
  END IF;
END $$;

CREATE OR REPLACE VIEW vw_application_conversion_funnel AS
select
  count(*)::int as applications_created,
  count(*) filter (where pipeline_state = 'OFF_TO_LENDER')::int as applications_submitted,
  count(*) filter (where pipeline_state = 'ACCEPTED')::int as applications_approved,
  count(*) filter (where pipeline_state = 'ACCEPTED')::int as applications_funded
from applications;

CREATE OR REPLACE VIEW vw_lender_conversion AS
select
  ls.lender_id,
  count(*)::int as submissions,
  count(*) filter (where a.pipeline_state = 'ACCEPTED')::int as approvals,
  count(*) filter (where a.pipeline_state = 'DECLINED')::int as declines,
  count(*) filter (where a.pipeline_state = 'ACCEPTED')::int as funded,
  case
    when count(*) = 0 then 0
    else count(*) filter (where a.pipeline_state = 'ACCEPTED')::numeric / count(*)::numeric
  end as approval_rate,
  case
    when count(*) = 0 then 0
    else count(*) filter (where a.pipeline_state = 'ACCEPTED')::numeric / count(*)::numeric
  end as funding_rate
from lender_submissions ls
join applications a on a.id = ls.application_id
group by ls.lender_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_name = 'lenders'
  ) THEN
    UPDATE lenders
    SET status = 'ACTIVE'::lender_status
    WHERE status IS NULL;

    UPDATE lenders
    SET status = 'ACTIVE'::lender_status
    WHERE LOWER(status::text) = 'active';

    UPDATE lenders
    SET status = 'INACTIVE'::lender_status
    WHERE LOWER(status::text) = 'inactive';
  END IF;
END $$;

ALTER TABLE IF EXISTS lenders
  ALTER COLUMN status SET DEFAULT 'ACTIVE'::lender_status,
  ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'applications'
      AND column_name = 'pipeline_state'
  ) THEN
    UPDATE applications
    SET pipeline_state = CASE
      WHEN pipeline_state IS NULL THEN 'RECEIVED'
      WHEN UPPER(pipeline_state) = 'NEW' THEN 'RECEIVED'
      WHEN UPPER(pipeline_state) = 'REQUIRES_DOCS' THEN 'DOCUMENTS_REQUIRED'
      WHEN UPPER(pipeline_state) = 'UNDER_REVIEW' THEN 'IN_REVIEW'
      WHEN UPPER(pipeline_state) = 'LENDER_SUBMITTED' THEN 'OFF_TO_LENDER'
      WHEN UPPER(pipeline_state) = 'APPROVED' THEN 'ACCEPTED'
      WHEN UPPER(pipeline_state) = 'FUNDED' THEN 'ACCEPTED'
      WHEN UPPER(pipeline_state) = 'DECLINED' THEN 'DECLINED'
      WHEN UPPER(pipeline_state) = 'DOCUMENTS_REQUIRED' THEN 'DOCUMENTS_REQUIRED'
      WHEN UPPER(pipeline_state) = 'IN_REVIEW' THEN 'IN_REVIEW'
      WHEN UPPER(pipeline_state) = 'START_UP' THEN 'START_UP'
      WHEN UPPER(pipeline_state) = 'OFF_TO_LENDER' THEN 'OFF_TO_LENDER'
      WHEN UPPER(pipeline_state) = 'ACCEPTED' THEN 'ACCEPTED'
      ELSE 'RECEIVED'
    END;

    ALTER TABLE applications
      ALTER COLUMN pipeline_state SET DEFAULT 'RECEIVED';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'applications'
      AND column_name = 'status'
  ) THEN
    UPDATE applications
    SET status = CASE
      WHEN status IS NULL THEN pipeline_state
      WHEN UPPER(status) = 'NEW' THEN 'RECEIVED'
      WHEN UPPER(status) = 'REQUIRES_DOCS' THEN 'DOCUMENTS_REQUIRED'
      WHEN UPPER(status) = 'UNDER_REVIEW' THEN 'IN_REVIEW'
      WHEN UPPER(status) = 'LENDER_SUBMITTED' THEN 'OFF_TO_LENDER'
      WHEN UPPER(status) = 'APPROVED' THEN 'ACCEPTED'
      WHEN UPPER(status) = 'FUNDED' THEN 'ACCEPTED'
      WHEN UPPER(status) = 'DECLINED' THEN 'DECLINED'
      WHEN UPPER(status) = 'DOCUMENTS_REQUIRED' THEN 'DOCUMENTS_REQUIRED'
      WHEN UPPER(status) = 'IN_REVIEW' THEN 'IN_REVIEW'
      WHEN UPPER(status) = 'START_UP' THEN 'START_UP'
      WHEN UPPER(status) = 'OFF_TO_LENDER' THEN 'OFF_TO_LENDER'
      WHEN UPPER(status) = 'ACCEPTED' THEN 'ACCEPTED'
      ELSE pipeline_state
    END;
  END IF;
END $$;
