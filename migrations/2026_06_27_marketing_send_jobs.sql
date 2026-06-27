-- BF_SERVER_SEND_QUEUE_v1 - durable queue for large marketing blasts.
CREATE TABLE IF NOT EXISTS marketing_send_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     text NOT NULL,
  silo        text NOT NULL,
  tag         text,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'queued',
  total       integer NOT NULL DEFAULT 0,
  sent        integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  created_by  text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_msj_status ON marketing_send_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_msj_silo ON marketing_send_jobs (silo, created_at DESC);
