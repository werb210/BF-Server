-- BF_SERVER_VOICEMAIL_PER_STAFF_v1 - voicemails are private to the staff member
-- the call was for. Add staff_user_id, backfill from call_logs by call_sid.
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS staff_user_id uuid;
CREATE INDEX IF NOT EXISTS voicemails_staff_user_id_idx ON voicemails(staff_user_id);
UPDATE voicemails v
   SET staff_user_id = cl.staff_user_id
  FROM call_logs cl
 WHERE cl.twilio_call_sid = v.call_sid
   AND v.staff_user_id IS NULL
   AND cl.staff_user_id IS NOT NULL;
