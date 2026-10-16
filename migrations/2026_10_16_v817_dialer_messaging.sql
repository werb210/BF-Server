-- BF_SERVER_v817_DIALER_MESSAGING
-- Idempotent: every statement is IF NOT EXISTS or a guarded UPDATE that matches nothing the second time.

-- 1. When the dialler last fetched a voice token (POST /api/voice/token). The IVR rings a staff
--    member whose app is closed (stale heartbeat) when their client identity is still registered.
ALTER TABLE staff_presence ADD COLUMN IF NOT EXISTS voice_token_at timestamptz;

-- 2. Client mini-portal messages saved with no contact (the application had none) never showed in
--    the staff Messages list, which requires contact_id. Backfill from the application's contact...
UPDATE communications_messages m
   SET contact_id = a.contact_id
  FROM applications a
 WHERE m.contact_id IS NULL
   AND m.application_id IS NOT NULL
   AND a.id::text = m.application_id::text
   AND a.contact_id IS NOT NULL;

-- ...then from the application's linked contacts (applicant first, then the oldest link).
UPDATE communications_messages m
   SET contact_id = ac.contact_id
  FROM (
    SELECT DISTINCT ON (application_id) application_id, contact_id
      FROM application_contacts
     ORDER BY application_id, (role = 'applicant') DESC, created_at ASC
  ) ac
 WHERE m.contact_id IS NULL
   AND m.application_id IS NOT NULL
   AND ac.application_id::text = m.application_id::text
   AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = ac.contact_id);

-- 3. Conversations named with a raw Twilio client identity ("client:client-<application id>" from
--    the mini-portal "Call us" button, "client:<staff user id>" from an internal call).
UPDATE communications_conversations cc
   SET contact_name = COALESCE(
         NULLIF(TRIM(COALESCE(NULLIF(TRIM(c.name), ''), TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')))), ''),
         NULLIF(TRIM(a.business_legal_name), ''),
         'Client app caller')
  FROM applications a
  LEFT JOIN contacts c ON c.id = a.contact_id
 WHERE cc.contact_name ILIKE 'client:client-%'
   AND a.id::text = substring(cc.contact_name from '^client:client-(.+)$');

UPDATE communications_conversations cc
   SET contact_name = COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), 'Boreal staff')
  FROM users u
 WHERE cc.contact_name ILIKE 'client:%'
   AND u.id::text = substring(cc.contact_name from '^client:(.+)$');

UPDATE communications_conversations
   SET contact_name = CASE WHEN contact_name ILIKE 'client:client-%' THEN 'Client app caller' ELSE 'Boreal staff' END
 WHERE contact_name ILIKE 'client:%';

-- 4. SMS rows with no contact. Outbound texts to a number with no contact were filed under
--    Boreal's own Twilio number, mixing every unknown recipient into one thread. First link each
--    orphan text to a live contact in its silo whose phone matches the OTHER party's number
--    (to_number on outbound, from_number on inbound)...
UPDATE communications_messages m
   SET contact_id = pick.cid
  FROM (
    SELECT o.id AS mid,
           (SELECT c.id
              FROM contacts c
             WHERE (c.silo = o.silo OR c.silo IS NULL)
               AND coalesce(c.status, 'active') <> 'archived'
               AND c.merged_into_id IS NULL
               AND length(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')) >= 10
               AND right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10)
                 = right(regexp_replace(coalesce(CASE WHEN o.direction = 'outbound' THEN o.to_number ELSE o.from_number END, ''), '[^0-9]', '', 'g'), 10)
             ORDER BY c.updated_at DESC NULLS LAST, c.created_at ASC NULLS LAST
             LIMIT 1) AS cid
      FROM communications_messages o
     WHERE o.type = 'sms'
       AND o.contact_id IS NULL
       AND length(regexp_replace(coalesce(CASE WHEN o.direction = 'outbound' THEN o.to_number ELSE o.from_number END, ''), '[^0-9]', '', 'g')) >= 10
  ) pick
 WHERE m.id = pick.mid
   AND pick.cid IS NOT NULL
   AND m.contact_id IS NULL;

-- ...then create a contact for each number staff TEXTED that still has none (named by the
-- formatted number, role 'other', like the live code), and link those rows too.
INSERT INTO contacts (id, name, first_name, last_name, phone, role, is_primary_applicant, silo, status)
SELECT gen_random_uuid(), x.label, x.label, '', x.e164, 'other', false, x.silo, 'active'
  FROM (
    SELECT DISTINCT ON (m.silo, right(regexp_replace(m.to_number, '[^0-9]', '', 'g'), 10))
           m.silo,
           '+1' || right(regexp_replace(m.to_number, '[^0-9]', '', 'g'), 10) AS e164,
           '(' || substr(right(regexp_replace(m.to_number, '[^0-9]', '', 'g'), 10), 1, 3) || ') '
               || substr(right(regexp_replace(m.to_number, '[^0-9]', '', 'g'), 10), 4, 3) || '-'
               || substr(right(regexp_replace(m.to_number, '[^0-9]', '', 'g'), 10), 7, 4) AS label
      FROM communications_messages m
     WHERE m.type = 'sms'
       AND m.direction = 'outbound'
       AND m.contact_id IS NULL
       AND m.silo IS NOT NULL
       AND length(regexp_replace(coalesce(m.to_number, ''), '[^0-9]', '', 'g')) IN (10, 11)
  ) x
 WHERE NOT EXISTS (
   SELECT 1 FROM contacts c
    WHERE (c.silo = x.silo OR c.silo IS NULL)
      AND right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = right(x.e164, 10)
 );

UPDATE communications_messages m
   SET contact_id = pick.cid
  FROM (
    SELECT o.id AS mid,
           (SELECT c.id
              FROM contacts c
             WHERE (c.silo = o.silo OR c.silo IS NULL)
               AND coalesce(c.status, 'active') <> 'archived'
               AND c.merged_into_id IS NULL
               AND length(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')) >= 10
               AND right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10)
                 = right(regexp_replace(coalesce(CASE WHEN o.direction = 'outbound' THEN o.to_number ELSE o.from_number END, ''), '[^0-9]', '', 'g'), 10)
             ORDER BY c.updated_at DESC NULLS LAST, c.created_at ASC NULLS LAST
             LIMIT 1) AS cid
      FROM communications_messages o
     WHERE o.type = 'sms'
       AND o.contact_id IS NULL
       AND length(regexp_replace(coalesce(CASE WHEN o.direction = 'outbound' THEN o.to_number ELSE o.from_number END, ''), '[^0-9]', '', 'g')) >= 10
  ) pick
 WHERE m.id = pick.mid
   AND pick.cid IS NOT NULL
   AND m.contact_id IS NULL;
