-- Block 112c — seed Twilio outbound caller ID for BI staff users that
-- don't have one. Idempotent: only updates NULLs. Mirrors v112b which
-- seeded BF staff.
--
-- Same number as BF per operator brief: +18254511768.
UPDATE users
   SET outbound_caller_id = '+18254511768'
 WHERE outbound_caller_id IS NULL
   AND (
     silo = 'BI'
     OR (silos IS NOT NULL AND 'BI' = ANY(silos))
   );
