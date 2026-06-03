-- BF_SERVER_BLOCK_v720_VOICEMAIL_FULL_v1
ALTER TABLE IF EXISTS voicemails
  ADD COLUMN IF NOT EXISTS blob_url         text,
  ADD COLUMN IF NOT EXISTS transcript       text,
  ADD COLUMN IF NOT EXISTS duration_seconds integer,
  ADD COLUMN IF NOT EXISTS contact_id       uuid,
  ADD COLUMN IF NOT EXISTS application_id   text,
  ADD COLUMN IF NOT EXISTS silo             text,
  ADD COLUMN IF NOT EXISTS from_number      text,
  ADD COLUMN IF NOT EXISTS conversation_id  uuid,
  ADD COLUMN IF NOT EXISTS message_id       uuid;
ALTER TABLE IF EXISTS communications_messages
  ADD COLUMN IF NOT EXISTS media_url              text,
  ADD COLUMN IF NOT EXISTS media_duration_seconds integer;
CREATE INDEX IF NOT EXISTS voicemails_contact_id_idx2 ON voicemails(contact_id);
