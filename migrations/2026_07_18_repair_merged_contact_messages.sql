-- BF_SERVER_REPAIR_MERGED_MSGS_v1 - after a contact merge the loser is archived (not deleted),
-- but any communications_messages still pointing at that archived contact are hidden from the SMS
-- tab, which threads strictly by a live contact_id. The CRM record still finds them by phone, so
-- the texts "disappear" from the tab only. Re-point every message that points at a merged-away
-- (archived) contact to its surviving contact so merged conversations reappear. Idempotent.
UPDATE communications_messages m
   SET contact_id = c.merged_into_id
  FROM contacts c
 WHERE m.contact_id = c.id
   AND c.merged_into_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM contacts s WHERE s.id = c.merged_into_id);
