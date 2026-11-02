-- BF_SERVER_v874_MARKETING_TOOLS - lead scoring, the campaign ledger (A/B subject test, best-time sending, the campaign
-- and funded-deal report) and the website lead-form kit. Ported from KS-server #48 (ks_marketing_addon.sql) without
-- the add-on billing columns, usage meters or plan limits. Every table carries the silo (BF / BI / SLF).
-- Idempotent: every statement can run again.

-- One row per person a campaign email went to (or will go to, at each person's best send time). The SendGrid webhook
-- fills opened_at / clicked_at / unsubscribed_at through the cs_id custom argument.
CREATE TABLE IF NOT EXISTS campaign_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  silo text NOT NULL DEFAULT 'BF',
  variant text NOT NULL DEFAULT 'A',
  subject text,
  status text NOT NULL DEFAULT 'sent',
  scheduled_for timestamptz,
  sent_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_sends_variant_check') THEN
    ALTER TABLE campaign_sends ADD CONSTRAINT campaign_sends_variant_check CHECK (variant IN ('A', 'B'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_sends_status_check') THEN
    ALTER TABLE campaign_sends ADD CONSTRAINT campaign_sends_status_check CHECK (status IN ('scheduled', 'sent', 'failed', 'skipped'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS campaign_sends_job_contact_uq ON campaign_sends (job_id, contact_id);
CREATE INDEX IF NOT EXISTS campaign_sends_due_idx ON campaign_sends (job_id, scheduled_for) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS campaign_sends_contact_idx ON campaign_sends (contact_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS campaign_sends_silo_idx ON campaign_sends (silo, created_at DESC);

-- Website kit: the lead forms put on a website, per silo. The kit's settings (public key, website addresses, chat
-- widget, tracking) live in boreal_settings under 'website_kit:<silo>'.
CREATE TABLE IF NOT EXISTS website_kit_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  name text NOT NULL,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  button_label text NOT NULL DEFAULT 'Send',
  thank_you text NOT NULL DEFAULT 'Thank you. We will be in touch shortly.',
  tag text,
  active boolean NOT NULL DEFAULT true,
  submissions integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE website_kit_forms ADD COLUMN IF NOT EXISTS silo text NOT NULL DEFAULT 'BF';
CREATE INDEX IF NOT EXISTS website_kit_forms_silo_idx ON website_kit_forms (silo, created_at);

-- Lead scores: rules (who the person is) plus engagement (what they did lately). The rules live in boreal_settings
-- under 'lead_scoring:<silo>'. Refreshed by the lead-score worker and whenever the portal looks scores up.
CREATE TABLE IF NOT EXISTS lead_scores (
  contact_id uuid PRIMARY KEY,
  silo text NOT NULL DEFAULT 'BF',
  score integer NOT NULL DEFAULT 0,
  rules_points integer NOT NULL DEFAULT 0,
  engagement_points integer NOT NULL DEFAULT 0,
  breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lead_scores ADD COLUMN IF NOT EXISTS silo text NOT NULL DEFAULT 'BF';
CREATE INDEX IF NOT EXISTS lead_scores_silo_score_idx ON lead_scores (silo, score DESC);
