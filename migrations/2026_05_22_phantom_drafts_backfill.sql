-- v616: collapse phantom-draft rows + change column default.
-- A row is a draft if submitted_at is NULL. The pre-fix default was 'new'
-- which v131 migrated to 'Received', making drafts indistinguishable
-- from real submissions on the portal pipeline. Flip them.

BEGIN;

-- Backfill: any row that never submitted is a draft.
UPDATE applications
   SET pipeline_state = 'draft'
 WHERE submitted_at IS NULL
   AND pipeline_state IS NOT NULL
   AND LOWER(pipeline_state) IN ('received', 'new');

-- Future-proof: new rows default to 'draft' until /submit flips them.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE applications ALTER COLUMN pipeline_state SET DEFAULT ''draft''';
EXCEPTION WHEN OTHERS THEN
  -- Column may not have a default to alter; ignore.
  NULL;
END$$;

COMMIT;
