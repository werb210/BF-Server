-- BF_SERVER_LENDER_PACKAGE_BACKOFF_v1
-- The signing gates requeued to 'pending' without next_attempt_at, so an
-- unsigned job was re-claimed every poll and never yielded. With a batch of 3,
-- three unsigned applications starved the queue and no lender received a
-- package at all.
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS job_queue_ready_idx
  ON job_queue (type, status, next_attempt_at);
