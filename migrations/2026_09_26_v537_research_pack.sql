-- BF_SERVER_BLOCK_v537_RESEARCH_PACK - public background per application, one
-- row per fact with its source and a staff check status. Idempotent.
CREATE TABLE IF NOT EXISTS company_research_cache (
  cache_key text PRIMARY KEY,
  places jsonb,
  web jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS application_research_facts (
  id bigserial PRIMARY KEY,
  application_id text NOT NULL,
  source text NOT NULL,
  category text NOT NULL DEFAULT 'web',
  label text NOT NULL,
  value text NOT NULL,
  url text,
  status text NOT NULL DEFAULT 'unverified',
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS application_research_facts_uq
  ON application_research_facts (application_id, source, label, value);
CREATE INDEX IF NOT EXISTS application_research_facts_app_idx
  ON application_research_facts (application_id);
