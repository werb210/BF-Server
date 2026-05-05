-- BF_SERVER_BLOCK_v133_LENDER_SELECTIONS_COLUMNS_v1
-- AUDIT-7: introduce columns the orchestrator already references.

ALTER TABLE application_lender_selections
  ADD COLUMN IF NOT EXISTS position      INTEGER;
ALTER TABLE application_lender_selections
  ADD COLUMN IF NOT EXISTS finalized_at  TIMESTAMPTZ;
ALTER TABLE application_lender_selections
  ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE application_lender_selections
   SET finalized_at = selected_at
 WHERE finalized_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_app_lender_selections_finalized_at
  ON application_lender_selections (application_id, finalized_at);
