-- BF_SERVER_CONTACT_NAME_REPAIR_v176
-- v170 stopped NEW applicants landing as "Unknown (application started)" but
-- left every existing row unrepaired. The real name is on the application:
-- applications.metadata->'applicant' (mirrored by bfBuildWizardMetadata) and
-- applications.metadata->'formData'->'applicant' (the raw wizard blob).
-- The legacy underscored form-data column does not exist in this schema; contact_id is the join.
--
-- publicApplication.ts writes last_name = '(application started)' on the draft,
-- so that fragment is stripped before the name is accepted.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'applications' AND column_name = 'contact_id'
  ) THEN
    RAISE NOTICE 'applications.contact_id absent, skipping v176 repair';
    RETURN;
  END IF;

  UPDATE contacts c
     SET name = n.derived,
         updated_at = now()
    FROM (
      SELECT a.contact_id,
             NULLIF(TRIM(regexp_replace(
               COALESCE(
                 NULLIF(TRIM(COALESCE(ap->>'fullName', ap->>'name', '')), ''),
                 NULLIF(TRIM(CONCAT_WS(' ', ap->>'firstName', ap->>'lastName')), ''),
                 ''
               ),
               '\(application started\)', '', 'gi')), '') AS derived
        FROM applications a
        CROSS JOIN LATERAL (
          SELECT COALESCE(
            a.metadata->'applicant',
            a.metadata->'borrower',
            a.metadata->'formData'->'applicant',
            a.metadata->'formData'->'borrower',
            a.metadata->'formData'->'applicants'->0
          ) AS ap
        ) x
       WHERE a.contact_id IS NOT NULL
         AND a.metadata IS NOT NULL
    ) n
   WHERE c.id = n.contact_id
     AND n.derived IS NOT NULL
     AND n.derived NOT ILIKE 'unknown'
     AND (
          c.name ILIKE '%(application started)%'
       OR c.name ILIKE 'unknown'
       OR COALESCE(c.name, '') = ''
     );
END $$;
