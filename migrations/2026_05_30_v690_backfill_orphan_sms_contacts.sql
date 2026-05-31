-- 2026_05_30_v690_backfill_orphan_sms_contacts.sql
-- BF_SERVER_BLOCK_v690_INBOUND_SMS_CONTACT_STAMP_v1 (data cleanup)
-- Inbound SMS were inserted without contact_id or type='sms', so they fell into
-- the Messages-tab "null" thread and inflated the Communications nav badge with
-- a count no click could clear (the stuck "16"). This backfill attaches each
-- orphaned inbound SMS to a contact (matched on the sender phone, else a new
-- phone-only contact), reclassifies it as type='sms' so it lives in the SMS tab
-- under that contact, and marks it read so the badge drops to 0. A final sweep
-- marks any remaining unattachable inbound orphan read so the badge fully
-- clears. Idempotent: afterward there are no contact_id-NULL inbound SMS with a
-- resolvable sender phone, so re-runs are no-ops. Exception-guarded so a schema
-- surprise skips the cleanup with a warning instead of failing BF-Server startup.
DO $$
BEGIN
  BEGIN
    -- 1) Attach orphaned inbound SMS to an EXISTING contact matched on the
    --    sender phone (last 10 digits, same silo); reclassify + mark read.
    WITH matched AS (
      SELECT DISTINCT ON (m.id)
             m.id AS message_id,
             c.id AS contact_id,
             cv.contact_phone
        FROM communications_messages m
        JOIN communications_conversations cv ON cv.id = m.conversation_id
        JOIN contacts c
          ON c.silo = COALESCE(m.silo, 'BF')
         AND c.phone IS NOT NULL
         AND length(regexp_replace(c.phone, '[^0-9]', '', 'g')) >= 10
         AND right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10)
           = right(regexp_replace(cv.contact_phone, '[^0-9]', '', 'g'), 10)
       WHERE m.contact_id IS NULL
         AND m.direction = 'inbound'
         AND m.channel = 'sms'
         AND cv.contact_phone IS NOT NULL
         AND length(regexp_replace(cv.contact_phone, '[^0-9]', '', 'g')) >= 10
       ORDER BY m.id, c.created_at ASC
    )
    UPDATE communications_messages m
       SET contact_id  = matched.contact_id,
           type        = 'sms',
           from_number = COALESCE(m.from_number, matched.contact_phone),
           read_at     = COALESCE(m.read_at, NOW())
      FROM matched
     WHERE m.id = matched.message_id;

    -- 2) For remaining orphaned inbound SMS whose sender phone has no contact,
    --    create one phone-only contact per distinct sender-phone suffix + silo.
    WITH orphan_phones AS (
      SELECT DISTINCT ON (COALESCE(m.silo, 'BF'), right(regexp_replace(cv.contact_phone, '[^0-9]', '', 'g'), 10))
             cv.contact_phone,
             COALESCE(m.silo, 'BF') AS silo,
             right(regexp_replace(cv.contact_phone, '[^0-9]', '', 'g'), 10) AS last10
        FROM communications_messages m
        JOIN communications_conversations cv ON cv.id = m.conversation_id
       WHERE m.contact_id IS NULL
         AND m.direction = 'inbound'
         AND m.channel = 'sms'
         AND cv.contact_phone IS NOT NULL
         AND length(regexp_replace(cv.contact_phone, '[^0-9]', '', 'g')) >= 10
       ORDER BY COALESCE(m.silo, 'BF'), right(regexp_replace(cv.contact_phone, '[^0-9]', '', 'g'), 10), cv.contact_phone
    )
    INSERT INTO contacts (name, first_name, last_name, phone, role, is_primary_applicant, silo, status)
    SELECT op.contact_phone, op.contact_phone, '', op.contact_phone, 'other', FALSE, op.silo, 'active'
      FROM orphan_phones op
     WHERE NOT EXISTS (
       SELECT 1
         FROM contacts c2
        WHERE c2.silo = op.silo
          AND c2.phone IS NOT NULL
          AND length(regexp_replace(c2.phone, '[^0-9]', '', 'g')) >= 10
          AND right(regexp_replace(c2.phone, '[^0-9]', '', 'g'), 10) = op.last10
     );

    -- 3) Attach to the newly created contacts (same match), reclassify + mark read.
    WITH matched AS (
      SELECT DISTINCT ON (m.id)
             m.id AS message_id,
             c.id AS contact_id,
             cv.contact_phone
        FROM communications_messages m
        JOIN communications_conversations cv ON cv.id = m.conversation_id
        JOIN contacts c
          ON c.silo = COALESCE(m.silo, 'BF')
         AND c.phone IS NOT NULL
         AND length(regexp_replace(c.phone, '[^0-9]', '', 'g')) >= 10
         AND right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10)
           = right(regexp_replace(cv.contact_phone, '[^0-9]', '', 'g'), 10)
       WHERE m.contact_id IS NULL
         AND m.direction = 'inbound'
         AND m.channel = 'sms'
         AND cv.contact_phone IS NOT NULL
       ORDER BY m.id, c.created_at ASC
    )
    UPDATE communications_messages m
       SET contact_id  = matched.contact_id,
           type        = 'sms',
           from_number = COALESCE(m.from_number, matched.contact_phone),
           read_at     = COALESCE(m.read_at, NOW())
      FROM matched
     WHERE m.id = matched.message_id;

    -- 4) Final sweep: mark any remaining inbound orphan (no resolvable phone)
    --    read so the nav badge reaches 0. Leaves type as-is.
    UPDATE communications_messages
       SET read_at = NOW()
     WHERE direction = 'inbound'
       AND read_at IS NULL
       AND contact_id IS NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'v690 orphan SMS backfill skipped: %', SQLERRM;
  END;
END $$;
