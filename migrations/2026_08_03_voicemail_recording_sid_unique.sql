-- BF_SERVER_VOICEMAIL_UNIFY_v9
-- Keep the richest, newest copy before enforcing one row per Twilio recording.
DELETE FROM voicemails v
 USING (
   SELECT id,
          row_number() OVER (
            PARTITION BY recording_sid
            ORDER BY (transcript IS NOT NULL) DESC,
                     (blob_url IS NOT NULL) DESC,
                     created_at DESC
          ) AS rn
     FROM voicemails
    WHERE recording_sid IS NOT NULL
 ) d
 WHERE v.id = d.id
   AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS voicemails_recording_sid_uq
  ON voicemails (recording_sid);
