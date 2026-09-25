-- BF_SERVER_BLOCK_v504_TEAM_LINK_PREVIEWS - cached page previews for links in Team chat. Idempotent.
CREATE TABLE IF NOT EXISTS link_previews (
  url         TEXT PRIMARY KEY,
  ok          BOOLEAN NOT NULL DEFAULT FALSE,
  title       TEXT,
  description TEXT,
  image_url   TEXT,
  site_name   TEXT,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
