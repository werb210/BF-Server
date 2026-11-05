-- BF_SERVER_v895_KS_INBOX - Keystone's shared mailboxes for the portal's Keystone inbox (/silo/ks/crm/inbox).
-- They are in silo KS only, so they never show in the Boreal (BF/BI/SLF) inbox. Idempotent.
INSERT INTO shared_mailbox_settings (address, display_name, silo, allowed_roles)
SELECT v.address, v.display_name, 'KS', ARRAY['Admin', 'Staff', 'Marketing']
  FROM (VALUES
    ('sales@keystonecrm.online', 'Keystone Sales'),
    ('support@keystonecrm.online', 'Keystone Support'),
    ('accounting@keystonecrm.online', 'Keystone Accounting'),
    ('info@keystonecrm.online', 'Keystone Info')
  ) AS v(address, display_name)
 WHERE NOT EXISTS (
   SELECT 1 FROM shared_mailbox_settings s WHERE LOWER(s.address) = v.address AND s.silo = 'KS'
 );
