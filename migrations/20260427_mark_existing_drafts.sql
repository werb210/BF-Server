-- Block 18: tag rows that look like draft placeholders (no business name, initial pipeline state)
-- so the Sales Pipeline filter is unambiguous going forward. Idempotent.
UPDATE applications
   SET metadata = jsonb_set(
     COALESCE(metadata, '{}'::jsonb),
     '{isDraft}',
     'true'::jsonb,
     true
   )
 WHERE COALESCE(metadata->>'isDraft', '') <> 'true'
   AND (name IS NULL OR name = '' OR name = 'Draft application')
   AND pipeline_state IN ('Received', 'Draft');
