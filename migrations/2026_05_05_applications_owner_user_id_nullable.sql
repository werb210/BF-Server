-- BF_SERVER_BLOCK_v137_READINESS_HANDOFF_REPAIR_v1
-- Drop NOT NULL on applications.owner_user_id so the website credit-readiness
-- controller (src/modules/website/website.controller.ts, v134) can insert
-- orphan draft rows that are claimed later by Step 1's
-- /api/public/application/start once the user OTPs in with the same phone.
--
-- Original constraint came from migration 006_applications_documents_pipeline_lender.sql.
-- Subsequent migrations (017, 025, 081) all called
--   ALTER TABLE applications ADD COLUMN IF NOT EXISTS owner_user_id uuid;
-- which were no-ops because the column already existed — none of them
-- removed the NOT NULL. Until this migration, every readiness handoff
-- produced a silent draftApplicationId=null in website.controller.ts:158.
--
-- Fully idempotent — DO block guards on is_nullable so a second run prints
-- "already nullable" and does nothing.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'applications'
      AND column_name = 'owner_user_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE applications ALTER COLUMN owner_user_id DROP NOT NULL;
    RAISE NOTICE 'applications.owner_user_id NOT NULL dropped (v137)';
  ELSE
    RAISE NOTICE 'applications.owner_user_id already nullable — v137 no-op';
  END IF;
END $$;
