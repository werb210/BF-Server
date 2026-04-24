ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS credit_summary_completed_at TIMESTAMPTZ;
