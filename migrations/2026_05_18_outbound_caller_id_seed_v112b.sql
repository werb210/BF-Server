-- Block 112b — seed the confirmed BF Twilio caller ID for any BF staff
-- user that doesn't have one. Idempotent: only updates NULLs.
UPDATE users
   SET outbound_caller_id = '+18254511768'
 WHERE outbound_caller_id IS NULL
   AND COALESCE(silo, 'BF') = 'BF';
