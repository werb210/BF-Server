-- Backfill contact_id on legacy inbound SMS rows stored with contact_id NULL
-- (before the inbound webhook matched senders by normalized phone). Links each
-- orphan inbound SMS to an existing contact whose phone matches by last-10
-- digits, within the same silo. Fixes duplicate "nameless" threads (e.g.
-- +16474258462 that should attach to its contact and merge into that thread).
-- Idempotent: only touches rows still NULL; recorded once in schema_migrations.
UPDATE communications_messages m
   SET contact_id = sub.cid
  FROM (
    SELECT m2.id AS mid,
           (SELECT c.id
              FROM contacts c
             WHERE c.phone IS NOT NULL
               AND length(regexp_replace(c.phone, '[^0-9]', '', 'g')) >= 10
               AND right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10)
                   = right(regexp_replace(coalesce(m2.from_number, ''), '[^0-9]', '', 'g'), 10)
               AND (c.silo = m2.silo OR m2.silo IS NULL OR c.silo IS NULL)
             ORDER BY c.created_at ASC NULLS LAST
             LIMIT 1) AS cid
      FROM communications_messages m2
     WHERE m2.contact_id IS NULL
       AND m2.type = 'sms'
       AND m2.direction = 'inbound'
       AND length(regexp_replace(coalesce(m2.from_number, ''), '[^0-9]', '', 'g')) >= 10
  ) sub
 WHERE m.id = sub.mid
   AND sub.cid IS NOT NULL;
