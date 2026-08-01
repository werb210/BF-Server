-- BF_SERVER_ACCOUNTANT_INVITE_GRAPH_v2
-- contact_id was TEXT while contacts.id is uuid, so the UPDATE that stamps
-- sent_at compared text to uuid and threw. Nothing has ever been written to
-- this table, so the cast is safe.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'accountant_invites'
       AND column_name = 'contact_id'
       AND data_type = 'text'
  ) THEN
    ALTER TABLE accountant_invites
      ALTER COLUMN contact_id TYPE uuid USING NULLIF(contact_id, '')::uuid;
  END IF;
END $$;
