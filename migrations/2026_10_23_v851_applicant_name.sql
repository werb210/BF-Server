-- BF_SERVER_v851_APPLICANT_NAME - repair applications that kept the OTP placeholder name.
--
-- The CRM contact created when an applicant verifies their phone is named "Unknown" "(application started)". The
-- wizard copied that placeholder into applications.metadata.applicant, so the Application tab and signing showed
-- "Unknown (application started)" even after staff corrected the contact (for example to the client's real name).
-- For every application whose metadata.applicant has no real name (every name field empty or the placeholder) and
-- whose linked contact has one, copy the contact's name into metadata.applicant firstName / lastName / fullName.
-- Idempotent: a repaired application has a real name and is not touched again; nothing else in metadata changes.
WITH src AS (
  SELECT a.id,
         NULLIF(btrim(c.first_name), '') AS cf,
         NULLIF(btrim(c.last_name), '') AS cl,
         NULLIF(btrim(regexp_replace(coalesce(c.name, ''), '\s+', ' ', 'g')), '') AS cn
    FROM applications a
    JOIN contacts c ON c.id = a.contact_id
   WHERE (a.metadata IS NULL OR jsonb_typeof(a.metadata) = 'object')
     AND NOT EXISTS (
           SELECT 1
             FROM unnest(ARRAY[
                    a.metadata->'applicant'->>'firstName',
                    a.metadata->'applicant'->>'lastName',
                    a.metadata->'applicant'->>'fullName',
                    a.metadata->'applicant'->>'name']) AS v(val)
            WHERE NULLIF(btrim(coalesce(v.val, '')), '') IS NOT NULL
              AND lower(btrim(v.val)) NOT IN ('unknown', 'unknown unknown')
              AND v.val NOT ILIKE '%(application started)%')
),
real AS (
  SELECT id,
         CASE WHEN cf IS NOT NULL AND lower(cf) <> 'unknown' AND cf NOT ILIKE '%(application started)%' THEN cf END AS rf,
         CASE WHEN cl IS NOT NULL AND lower(cl) <> 'unknown' AND cl NOT ILIKE '%(application started)%' THEN cl END AS rl,
         CASE WHEN cn IS NOT NULL AND lower(cn) NOT IN ('unknown', 'unknown unknown') AND cn NOT ILIKE '%(application started)%' THEN cn END AS rn
    FROM src
),
fix AS (
  SELECT id,
         CASE WHEN rf IS NOT NULL OR rl IS NOT NULL THEN coalesce(rf, '') ELSE split_part(rn, ' ', 1) END AS first_name,
         CASE WHEN rf IS NOT NULL OR rl IS NOT NULL THEN coalesce(rl, '')
              ELSE btrim(substr(rn, length(split_part(rn, ' ', 1)) + 1)) END AS last_name
    FROM real
   WHERE rf IS NOT NULL OR rl IS NOT NULL OR rn IS NOT NULL
)
UPDATE applications a
   SET metadata = jsonb_set(
         COALESCE(a.metadata, '{}'::jsonb), '{applicant}',
         (CASE WHEN jsonb_typeof(a.metadata->'applicant') = 'object' THEN a.metadata->'applicant' ELSE '{}'::jsonb END)
           || jsonb_build_object(
                'firstName', fix.first_name,
                'lastName', fix.last_name,
                'fullName', btrim(fix.first_name || ' ' || fix.last_name)),
         true),
       updated_at = now()
  FROM fix
 WHERE a.id = fix.id;
