-- BF_SERVER_BLOCK_v780_PUBLIC_LANDING — hosted "view in browser" pages for
-- marketing email/SMS. Per-send instance keyed by slug; html is the rendered
-- branded email so the page is an exact mirror of what was sent.
CREATE TABLE IF NOT EXISTS marketing_landing_pages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  silo        text NOT NULL DEFAULT 'BF',
  title       text,
  html        text NOT NULL,
  fields      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mlp_slug ON marketing_landing_pages (slug);
CREATE INDEX IF NOT EXISTS idx_mlp_silo ON marketing_landing_pages (silo, created_at DESC);
