-- BF_SERVER_BLOCK_v171_JOB_QUEUE_TABLE_v1
-- Defensive create of job_queue. Code at src/modules/applications/
-- applications.service.ts:1128 and src/routes/signnow.ts:87 INSERTs
-- into this table; src/workers/lenderPackageWorker.ts polls it.
-- No prior migration creates it. Idempotent.
--
-- Schema matches the code's INSERT shape and the worker's SELECT shape:
--   INSERT (id, type, payload, status, created_at)
--   SELECT id, type, payload, status, error, attempts, created_at, updated_at

CREATE TABLE IF NOT EXISTS job_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed','dead')),
  error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Defensive ALTERs in case the table already exists (manually-created prod)
-- but is missing the retry-tracking columns added by this migration.
ALTER TABLE job_queue
  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS error TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS job_queue_status_type_idx
  ON job_queue(status, type) WHERE status IN ('pending','running');

CREATE INDEX IF NOT EXISTS job_queue_next_attempt_idx
  ON job_queue(next_attempt_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS job_queue_created_idx
  ON job_queue(created_at DESC);

DO $$ BEGIN RAISE NOTICE 'BF_SERVER_BLOCK_v171_JOB_QUEUE_TABLE_v1 applied'; END $$;
