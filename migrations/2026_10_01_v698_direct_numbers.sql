-- BF_SERVER_RECEPTION_MENU_v698 - give Todd and Andrew their Twilio direct lines.
-- Only fills an empty direct_number, and never takes a number another user already has.
UPDATE users SET direct_number = '+18254511768'
 WHERE lower(email) = 'todd.w@boreal.financial' AND direct_number IS NULL
   AND NOT EXISTS (SELECT 1 FROM users o WHERE o.direct_number = '+18254511768');
UPDATE users SET direct_number = '+15874165992'
 WHERE lower(email) = 'andrew.p@boreal.financial' AND direct_number IS NULL
   AND NOT EXISTS (SELECT 1 FROM users o WHERE o.direct_number = '+15874165992');
