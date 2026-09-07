-- BF_SERVER_CRM_SEGMENTS_v1
CREATE TABLE IF NOT EXISTS crm_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  name text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_segments_silo_idx ON crm_segments (silo);
