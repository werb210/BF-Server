-- BF_SERVER_BLOCK_v456_LENDER_PACKAGE_LINK
-- A package too large to email goes out as a private download link instead.
-- One row per link; downloads are counted so staff can see the lender opened it.
CREATE TABLE IF NOT EXISTS lender_package_links (
  token               TEXT PRIMARY KEY,
  application_id      TEXT NOT NULL,
  lender_id           TEXT NOT NULL,
  blob_name           TEXT NOT NULL,
  filename            TEXT NOT NULL,
  size_bytes          BIGINT,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  download_count      INTEGER NOT NULL DEFAULT 0,
  last_downloaded_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_lender_package_links_app
  ON lender_package_links (application_id, lender_id);
