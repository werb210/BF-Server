-- BF_SERVER_BLOCK_v841_FOLLOWUP_NOTIFY_ONCE — ensure the dedup constraint exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_unique_per_ref') THEN
    DELETE FROM notifications a USING notifications b
     WHERE a.ctid < b.ctid
       AND a.user_id = b.user_id AND a.ref_table = b.ref_table
       AND a.ref_id = b.ref_id AND a.type = b.type;
    ALTER TABLE notifications
      ADD CONSTRAINT notifications_unique_per_ref UNIQUE (user_id, ref_table, ref_id, type);
  END IF;
END $$;
UPDATE crm_email_log SET followup_notified_at = now()
 WHERE followup_notified_at IS NULL AND created_at < now() - interval '24 hours';
