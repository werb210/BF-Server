-- BF_SERVER_BLOCK_v534_CRM_AI_BRIEF - cached description of a company taken
-- from its own website and refreshed every 30 days. Idempotent.
CREATE TABLE IF NOT EXISTS crm_company_web_profiles (
  domain text PRIMARY KEY,
  summary text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
