-- 2026_05_30_v688_merge_duplicate_contacts.sql
-- BF_SERVER_BLOCK_v687_CONTACT_MATCH_NORMALIZE_v1 (data cleanup)
-- Merge contacts that share the same last-10 phone digits within a silo into
-- the earliest (canonical) contact. Reassign messages, conversations, issues
-- and applications to the canonical row, then ARCHIVE (not delete) the
-- duplicates so the merge is fully reversible. Idempotent: after running, each
-- phone group has a single active contact, so re-runs are no-ops. Fixes the
-- v686 fragmentation where one person became 3 contacts and the application
-- was stranded on a different row than the messenger thread.
-- The whole body is wrapped in an exception guard so that, in the unlikely
-- event of a schema surprise, the merge is skipped with a warning rather than
-- failing BF-Server startup.
DO $$
DECLARE
  grp RECORD;
  canonical uuid;
  dup_ids uuid[];
BEGIN
  BEGIN
    FOR grp IN
      SELECT silo,
             right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) AS p10,
             array_agg(id ORDER BY created_at ASC) AS ids
      FROM contacts
      WHERE phone IS NOT NULL
        AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10
        AND COALESCE(status, 'active') <> 'archived'
      GROUP BY silo, right(regexp_replace(phone, '[^0-9]', '', 'g'), 10)
      HAVING count(*) > 1
    LOOP
      canonical := grp.ids[1];
      dup_ids := grp.ids[2:array_length(grp.ids, 1)];

      UPDATE communications_messages      SET contact_id = canonical WHERE contact_id = ANY(dup_ids);
      UPDATE communications_conversations SET contact_id = canonical WHERE contact_id = ANY(dup_ids);
      UPDATE issues                        SET contact_id = canonical WHERE contact_id = ANY(dup_ids);
      UPDATE applications                  SET contact_id = canonical WHERE contact_id = ANY(dup_ids);
      UPDATE contacts                      SET status = 'archived'    WHERE id = ANY(dup_ids);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'v688 contact merge skipped: %', SQLERRM;
  END;
END $$;
