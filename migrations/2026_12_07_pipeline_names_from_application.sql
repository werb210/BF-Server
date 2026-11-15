-- PIPELINE_NAME_FROM_APPLICATION - an application whose client typed the business name but had not submitted kept the
-- placeholder name "Draft application", so the pipeline board hid it as an empty draft. Copy the name the client typed
-- (kept in metadata) onto the application where the name is still a placeholder. Safe to run again.
UPDATE applications a
   SET name = v.nm, updated_at = a.updated_at
  FROM (
    SELECT id, NULLIF(btrim(COALESCE(
             metadata->'business'->>'legalName', metadata->'business'->>'companyName', metadata->'business'->>'businessName', metadata->'business'->>'name',
             metadata->'company'->>'legalName', metadata->'company'->>'companyName', metadata->'company'->>'name',
             metadata->'business_info'->>'legalName', metadata->'business_info'->>'companyName', metadata->'business_info'->>'name')), '') AS nm
      FROM applications
     WHERE COALESCE(name, '') IN ('', 'Draft application', 'Untitled Application')
  ) v
 WHERE v.id = a.id AND v.nm IS NOT NULL;
