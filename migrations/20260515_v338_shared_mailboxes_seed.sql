-- BF_SERVER_BLOCK_v338_SHARED_MAILBOXES_SEED_v1
-- Seed submissions@boreal.financial as a BF-silo shared mailbox and
-- align info@'s allowed_roles to {Admin, Staff, Ops}. Idempotent.

BEGIN;

-- Add submissions@ if not already present (BF silo).
INSERT INTO shared_mailbox_settings (address, display_name, silo, allowed_roles)
SELECT 'submissions@boreal.financial',
       'Boreal Financial — Submissions',
       'BF',
       ARRAY['Admin', 'Staff', 'Ops']
WHERE NOT EXISTS (
  SELECT 1 FROM shared_mailbox_settings
  WHERE LOWER(address) = 'submissions@boreal.financial' AND silo = 'BF'
);

-- Bring info@ allowed_roles into line with the operator's role set.
-- Migration 136 seeded it with the default {Admin, Staff, Marketing}.
UPDATE shared_mailbox_settings
   SET allowed_roles = ARRAY['Admin', 'Staff', 'Ops']
 WHERE LOWER(address) = 'info@boreal.financial'
   AND silo = 'BF';

-- Optional BI-silo visibility for Andrew. Uncomment to duplicate the
-- two mailboxes under silo='BI' so they appear in the BI dropdown too.
-- INSERT INTO shared_mailbox_settings (address, display_name, silo, allowed_roles)
-- SELECT 'submissions@boreal.financial',
--        'Boreal Financial — Submissions',
--        'BI',
--        ARRAY['Admin', 'Staff', 'Ops']
-- WHERE NOT EXISTS (
--   SELECT 1 FROM shared_mailbox_settings
--   WHERE LOWER(address) = 'submissions@boreal.financial' AND silo = 'BI'
-- );
-- INSERT INTO shared_mailbox_settings (address, display_name, silo, allowed_roles)
-- SELECT 'info@boreal.financial',
--        'Boreal Financial — Info',
--        'BI',
--        ARRAY['Admin', 'Staff', 'Ops']
-- WHERE NOT EXISTS (
--   SELECT 1 FROM shared_mailbox_settings
--   WHERE LOWER(address) = 'info@boreal.financial' AND silo = 'BI'
-- );

COMMIT;
