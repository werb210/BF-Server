-- BF_SERVER_BLOCK_v775 — one-off: the existing equipment app (4E2683A1) was
-- submitted before the doc-upload-prompt existed, so it has no "Upload
-- documents" messenger button and sits in "Received" despite needing docs.
-- Seed the messenger prompt + move it to "Documents Required". Idempotent.
DO $$
DECLARE app_id text := 'a0d0daf4-8a68-45e5-ab93-6e394e2683a1';
BEGIN
  IF EXISTS (SELECT 1 FROM applications WHERE id::text = app_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM communications_messages
       WHERE application_id = app_id AND cta_action = 'upload_docs'
    ) THEN
      INSERT INTO communications_messages
        (id, type, direction, status, application_id, contact_id, silo, body, staff_name, cta_label, cta_action, created_at)
      SELECT gen_random_uuid(), 'message', 'outbound', 'sent', a.id::text,
             a.contact_id, COALESCE(a.silo,'BF'),
             'To continue your application, please upload your supporting documents.',
             'Boreal Financial', 'Upload documents', 'upload_docs', now()
        FROM applications a WHERE a.id::text = app_id;
      RAISE NOTICE 'v775: seeded upload-docs prompt for %', app_id;
    END IF;
    UPDATE applications SET pipeline_state = 'Documents Required', updated_at = now()
     WHERE id::text = app_id AND pipeline_state IN ('Received','received');
  END IF;
END $$;
