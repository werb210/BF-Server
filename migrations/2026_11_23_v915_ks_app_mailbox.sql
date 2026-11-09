-- BF_SERVER_v915_KS_APP_MAILBOX - app@keystonecrm.online (Keystone's shared account for third-party service sign-ups
-- such as SignNow) in the Keystone inbox next to Sales, Support, Accounting and Info. Silo KS only. Idempotent.
INSERT INTO shared_mailbox_settings (address, display_name, silo, allowed_roles)
SELECT 'app@keystonecrm.online', 'Keystone App', 'KS', ARRAY['Admin', 'Staff', 'Marketing']
 WHERE NOT EXISTS (
   SELECT 1 FROM shared_mailbox_settings s WHERE LOWER(s.address) = 'app@keystonecrm.online' AND s.silo = 'KS'
 );
