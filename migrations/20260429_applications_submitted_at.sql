-- BF_APPLICATIONS_SUBMITTED_AT_v62 — add submitted_at column to applications.
--
-- Live bug observed 2026-04-29 in Azure App Service log stream:
--   POST /api/client/applications/<token>/submit -> 500
--   "column \"submitted_at\" of relation \"applications\" does not exist"
--
-- The submit handler at src/routes/client/v1Applications.ts:291 does:
--   UPDATE applications
--      SET ..., submitted_at = NOW(), updated_at = NOW()
--    WHERE id::text = ($5)::text
--
-- The applications table never had a submitted_at column. Other tables that
-- DO have it (lender_submissions, transmissions, credit_summaries) are
-- unrelated; the bug is specifically that the applications table is missing
-- this column the code is trying to write.
--
-- Fix: ALTER TABLE applications ADD COLUMN IF NOT EXISTS submitted_at.
-- Idempotent (IF NOT EXISTS). Backfill from metadata.submittedAt where
-- present (any application that "submitted" via the buggy path before this
-- migration ran will have its submission timestamp recorded inside the
-- metadata jsonb blob; preserve it).
--
-- Index is partial (WHERE submitted_at IS NOT NULL) because most rows in
-- applications are drafts and never submit.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;

-- Backfill from metadata if available. Both write paths in v1Applications.ts
-- write submittedAt to metadata.formData.submittedAt (legacy path) and/or
-- metadata.submittedAt. Prefer the top-level key when both exist.
UPDATE applications
   SET submitted_at = COALESCE(
         NULLIF(metadata->>'submittedAt', '')::TIMESTAMPTZ,
         NULLIF(metadata->'formData'->>'submittedAt', '')::TIMESTAMPTZ
       )
 WHERE submitted_at IS NULL
   AND metadata IS NOT NULL
   AND (
        (metadata ? 'submittedAt' AND metadata->>'submittedAt' <> '')
     OR (
          (metadata->'formData') IS NOT NULL
          AND (metadata->'formData') ? 'submittedAt'
          AND metadata->'formData'->>'submittedAt' <> ''
        )
       );

CREATE INDEX IF NOT EXISTS applications_submitted_at_idx
  ON applications (submitted_at)
  WHERE submitted_at IS NOT NULL;
