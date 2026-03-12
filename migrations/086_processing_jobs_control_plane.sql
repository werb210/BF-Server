CREATE TABLE document_processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL,
  document_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE banking_analysis_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE applications
  ADD COLUMN ocr_completed_at TIMESTAMPTZ,
  ADD COLUMN banking_completed_at TIMESTAMPTZ;
