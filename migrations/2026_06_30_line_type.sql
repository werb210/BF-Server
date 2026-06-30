-- BF_SERVER_BLOCK_v784_LINE_TYPE — cache Twilio Lookup line type per contact.
ALTER TABLE IF EXISTS contacts ADD COLUMN IF NOT EXISTS line_type text;
ALTER TABLE IF EXISTS contacts ADD COLUMN IF NOT EXISTS line_type_checked_at timestamptz;
