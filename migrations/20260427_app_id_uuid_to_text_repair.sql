-- BF_APP_ID_UUID_TO_TEXT_v38 — Block 38-A
-- applications.id is text (migration 006). At least seven later migrations
-- declared application_id columns as uuid, which is a type mismatch with the
-- referenced text PK. Postgres surfaces the mismatch as
-- "operator does not exist: text = uuid" any time SQL or a view JOINs an
-- application_id column to applications.id. This migration converts every
-- such column to text and reattaches the FK.
-- Safe to re-run: every step is guarded.

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT c.table_schema, c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name IN ('application_id','converted_application_id')
      AND c.data_type = 'uuid'
      AND c.table_name <> 'applications'
  LOOP
    -- Drop FK if present (name is not always predictable).
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I',
      rec.table_schema, rec.table_name,
      rec.table_name || '_' || rec.column_name || '_fkey'
    );
    -- Convert column type uuid -> text. uuid::text is implicit-safe.
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE text USING %I::text',
      rec.table_schema, rec.table_name, rec.column_name, rec.column_name
    );
    -- For application_id columns specifically, restore the FK to applications.
    IF rec.column_name = 'application_id' THEN
      EXECUTE format(
        'ALTER TABLE %I.%I
           ADD CONSTRAINT %I
           FOREIGN KEY (%I) REFERENCES applications(id) ON DELETE SET NULL',
        rec.table_schema, rec.table_name,
        rec.table_name || '_' || rec.column_name || '_fkey',
        rec.column_name
      );
    END IF;
    RAISE NOTICE 'Converted %.%.% from uuid to text', rec.table_schema, rec.table_name, rec.column_name;
  END LOOP;
END $$;

-- Indexes that may have been built on the old uuid column survive automatic
-- type coercion to text in Postgres 14+, but recreate the most-queried one
-- explicitly to be safe.
CREATE INDEX IF NOT EXISTS idx_comm_messages_application_id
  ON communications_messages(application_id);
