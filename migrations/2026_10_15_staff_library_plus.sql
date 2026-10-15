-- BF_SERVER_v810_LIBRARY_PLUS
-- The Staff Library (one OneDrive folder shared with everyone at Boreal, v776) gets Dropbox-style features.
-- OneDrive keeps the files; these tables keep what OneDrive cannot: the team's activity, each person's stars,
-- a 30-day recycle bin, share links for people outside Boreal, and upload links ("file requests").

ALTER TABLE staff_library ADD COLUMN IF NOT EXISTS trash_item_id text;

-- Who did what, for Activity and Recent.
CREATE TABLE IF NOT EXISTS library_activity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     text NOT NULL,
  item_name   text NOT NULL,
  is_folder   boolean NOT NULL DEFAULT false,
  action      text NOT NULL,
  actor_id    text,
  actor_name  text,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_activity_created_idx ON library_activity (created_at DESC);
CREATE INDEX IF NOT EXISTS library_activity_item_idx ON library_activity (item_id, created_at DESC);

-- Each person's starred files and folders.
CREATE TABLE IF NOT EXISTS library_stars (
  user_id     text NOT NULL,
  item_id     text NOT NULL,
  item_name   text NOT NULL,
  is_folder   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);

-- Deleted items wait 30 days in the library's own "Recycle Bin (Boreal)" folder before they are removed.
CREATE TABLE IF NOT EXISTS library_trash (
  item_id            text PRIMARY KEY,
  item_name          text NOT NULL,
  is_folder          boolean NOT NULL DEFAULT false,
  original_parent_id text NOT NULL,
  original_path      text,
  deleted_by         text,
  deleted_by_name    text,
  deleted_at         timestamptz NOT NULL DEFAULT now()
);

-- Links for people outside Boreal: view or download one file, with an expiry and an optional password.
CREATE TABLE IF NOT EXISTS library_share_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      text NOT NULL,
  item_id         text NOT NULL,
  item_name       text NOT NULL,
  allow_download  boolean NOT NULL DEFAULT true,
  password_hash   text,
  expires_at      timestamptz NOT NULL,
  created_by      text NOT NULL,
  created_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  open_count      integer NOT NULL DEFAULT 0,
  last_opened_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS library_share_links_token_uidx ON library_share_links (token_hash);

-- Upload links: anyone with the link can upload files into one library folder until it expires.
CREATE TABLE IF NOT EXISTS library_file_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      text NOT NULL,
  folder_id       text NOT NULL,
  folder_name     text NOT NULL,
  title           text NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_by      text NOT NULL,
  created_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  upload_count    integer NOT NULL DEFAULT 0,
  last_upload_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS library_file_requests_token_uidx ON library_file_requests (token_hash);
