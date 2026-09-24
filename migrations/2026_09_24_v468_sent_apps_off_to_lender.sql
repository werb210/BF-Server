-- BF_SERVER_BLOCK_v468_STAGE_AFTER_SEND
-- Applications whose package already went to a lender but sit in Received or In
-- Review (e.g. moved back to In Review when their documents were all accepted).
-- Additional Steps Required is left alone: it is a legitimate stage after a
-- lender asks for more. Idempotent: a second run matches nothing.
UPDATE applications a
   SET pipeline_state = 'Off to Lender', updated_at = now()
 WHERE a.pipeline_state IN ('Received', 'In Review')
   AND EXISTS (
     SELECT 1 FROM application_packages p
      WHERE p.application_id::text = a.id::text
        AND p.sent_at IS NOT NULL
   );
