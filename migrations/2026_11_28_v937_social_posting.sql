-- BF_SERVER_v937_SOCIAL_POSTING - connect social accounts, write one post, publish or schedule it to all of them.
CREATE TABLE IF NOT EXISTS social_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  network text NOT NULL CHECK (network IN ('facebook', 'instagram', 'threads', 'linkedin', 'x', 'google_business', 'bluesky')),
  external_id text NOT NULL,
  name text NOT NULL,
  access_token_enc text,
  refresh_token_enc text,
  expires_at timestamptz,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'connected',
  last_error text,
  connected_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (silo, network, external_id)
);
CREATE TABLE IF NOT EXISTS social_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  body text NOT NULL,
  link_url text,
  image_url text,
  account_ids uuid[] NOT NULL,
  scheduled_at timestamptz,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled')),
  results jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS social_posts_due ON social_posts (scheduled_at) WHERE status = 'scheduled';
