-- BF_SERVER_CONTACT_SECONDARY_v1 - a second email + phone per contact (BF), so a merge keeps
-- the loser's distinct email/phone instead of discarding it.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS secondary_email text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS secondary_phone text;
