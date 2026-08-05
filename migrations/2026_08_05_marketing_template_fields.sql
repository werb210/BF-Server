-- BF_SERVER_TEMPLATE_FIELDS_ROUNDTRIP_v17
-- marketing_template stored only subject/body/link_url/html, so Save to library
-- discarded every headline, image, image link and button on BOTH columns, and
-- the library load could not restore them. One jsonb column holds the whole
-- composer state so a saved template round-trips exactly.
ALTER TABLE marketing_template ADD COLUMN IF NOT EXISTS fields jsonb;
