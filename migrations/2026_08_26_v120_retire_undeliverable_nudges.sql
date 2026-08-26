-- BF_SERVER_ABANDON_SMS_TARGET_v120
-- Retire every pending nudge whose number can never receive SMS, so nothing
-- already in the table can start the loop again after deploy.
UPDATE applications a
   SET abandon_sms_sent_at = now()
  FROM contacts c
 WHERE c.id = a.contact_id
   AND a.submitted_at IS NULL
   AND a.abandon_sms_sent_at IS NULL
   AND (
        regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g') LIKE '%5555555'
     OR regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g') LIKE '%55501__'
     OR length(regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g')) < 10
     OR regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g') ~ '^(.)\1+$'
   );
