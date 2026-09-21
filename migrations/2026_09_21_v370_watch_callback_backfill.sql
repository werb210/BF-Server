-- BF_SERVER_WATCH_CALLBACK_FROM_OTP_v370
-- Watch calls ring the staff member's own cell first, then bridge to the
-- client. Nothing ever wrote users.verified_callback_number, so every Watch
-- call was refused with callback_not_verified. A staff login phone has already
-- passed an SMS code, which is the same proof a callback check would ask for.
-- Idempotent: only fills rows that are still empty.
UPDATE users
   SET verified_callback_number = phone_number,
       callback_verified_at = COALESCE(callback_verified_at, now())
 WHERE verified_callback_number IS NULL
   AND phone_number IS NOT NULL
   AND COALESCE(phone_verified, false) = true;
