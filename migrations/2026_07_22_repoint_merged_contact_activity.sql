-- BF_SERVER_INBOUND_SMS_MERGED_CONTACT_v1
-- Repair pass: any activity still pointing at a contact that was archived by a merge is
-- moved onto the live survivor. Follows merge CHAINS (A -> B -> C) via a recursive CTE so
-- a contact merged twice does not strand its history on an intermediate record.
-- Fully idempotent: re-running finds nothing left to move. Additive only, no schema change.
WITH RECURSIVE chain(loser_id, survivor_id) AS (
  SELECT c.id, c.merged_into_id
    FROM contacts c
   WHERE c.merged_into_id IS NOT NULL
  UNION ALL
  SELECT ch.loser_id, c.merged_into_id
    FROM chain ch
    JOIN contacts c ON c.id = ch.survivor_id
   WHERE c.merged_into_id IS NOT NULL
),
final AS (
  SELECT ch.loser_id,
         ch.survivor_id
    FROM chain ch
    JOIN contacts s ON s.id = ch.survivor_id
   WHERE s.merged_into_id IS NULL
     AND coalesce(s.status, '') <> 'archived'
)
UPDATE communications_messages m
   SET contact_id = f.survivor_id
  FROM final f
 WHERE m.contact_id = f.loser_id;

WITH RECURSIVE chain(loser_id, survivor_id) AS (
  SELECT c.id, c.merged_into_id
    FROM contacts c
   WHERE c.merged_into_id IS NOT NULL
  UNION ALL
  SELECT ch.loser_id, c.merged_into_id
    FROM chain ch
    JOIN contacts c ON c.id = ch.survivor_id
   WHERE c.merged_into_id IS NOT NULL
),
final AS (
  SELECT ch.loser_id, ch.survivor_id
    FROM chain ch
    JOIN contacts s ON s.id = ch.survivor_id
   WHERE s.merged_into_id IS NULL
     AND coalesce(s.status, '') <> 'archived'
)
UPDATE call_logs cl
   SET crm_contact_id = f.survivor_id
  FROM final f
 WHERE cl.crm_contact_id = f.loser_id;
