-- Add columns to surface what the match engine actually used + what was missing.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS lender_matches_inputs jsonb,
  ADD COLUMN IF NOT EXISTS lender_matches_missing_inputs jsonb DEFAULT '[]'::jsonb;
