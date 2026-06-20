-- BF_SERVER_COMPANIES_DEDUPE_v1 — merge duplicate companies (same silo + normalized name) into the
-- earliest record, repointing every company_id reference, so the CRM stops showing duplicate
-- company rows (e.g. "Brant CoLab" / "Dr. Peter vlahos..." appearing twice). Idempotent.
DO $$
DECLARE
  ref RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'companies'
  ) THEN
    RETURN;
  END IF;

  DROP TABLE IF EXISTS _company_keep;
  CREATE TEMP TABLE _company_keep AS
  SELECT id,
         first_value(id) OVER (
           PARTITION BY silo, lower(btrim(name))
           ORDER BY created_at NULLS FIRST, id
         ) AS keep_id
  FROM companies;

  FOR ref IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'company_id'
  LOOP
    EXECUTE format(
      'UPDATE public.%I t SET company_id = k.keep_id FROM _company_keep k '
      || 'WHERE t.company_id = k.id AND k.id <> k.keep_id',
      ref.table_name
    );
  END LOOP;

  DELETE FROM companies c USING _company_keep k
  WHERE c.id = k.id AND k.id <> k.keep_id;

  DROP TABLE IF EXISTS _company_keep;
END $$;
