ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS processing_stage TEXT NOT NULL DEFAULT 'pending';
