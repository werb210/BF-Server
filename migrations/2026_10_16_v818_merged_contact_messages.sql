-- BF_SERVER_v818_MERGED_CONTACT
-- A contact merge archives the loser (merged_into_id set). Client-portal chats and applications still pointing at
-- the loser were hidden from the portal's Messages tab. Repoint them to the live survivor. Idempotent: a second run
-- matches nothing.
UPDATE communications_messages m
   SET contact_id = surv.id
  FROM contacts c
  JOIN contacts surv ON surv.id = c.merged_into_id
 WHERE m.contact_id = c.id
   AND c.merged_into_id IS NOT NULL
   AND coalesce(surv.status, 'active') <> 'archived'
   AND surv.merged_into_id IS NULL;

UPDATE applications a
   SET contact_id = surv.id
  FROM contacts c
  JOIN contacts surv ON surv.id = c.merged_into_id
 WHERE a.contact_id = c.id
   AND c.merged_into_id IS NOT NULL
   AND coalesce(surv.status, 'active') <> 'archived'
   AND surv.merged_into_id IS NULL;
