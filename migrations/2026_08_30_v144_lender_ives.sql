-- BF_SERVER_PER_LENDER_IVES_v144
-- Line 5a of IRS Form 4506-C names the IVES participant who receives the tax
-- transcript. That is the LENDER, so it cannot come from a single set of
-- environment variables on a marketplace that sends one file to several of them.
-- A 4506-C naming lender A does not authorise lender B to pull anything.
--
-- These live on the lender, next to the contact and submission details already
-- kept there. Nullable: most lenders are not IVES participants and never will be,
-- and a null simply means no 4506-C is produced for them.
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS ives_participant_name TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS ives_participant_id   TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS ives_sor_mailbox_id   TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS ives_street           TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS ives_city             TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS ives_state            TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS ives_zip              TEXT;
