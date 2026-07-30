-- BF_SERVER_SEQ_AUDIENCE_TAGS_v1
-- A sequence audience was a single include tag (audience_tag) with no way to
-- exclude anyone. audience_tag stays in place and is still honoured so old
-- sequences retain their audience.
ALTER TABLE marketing_sequences ADD COLUMN IF NOT EXISTS audience_include_tags TEXT[];
ALTER TABLE marketing_sequences ADD COLUMN IF NOT EXISTS audience_exclude_tags TEXT[];
