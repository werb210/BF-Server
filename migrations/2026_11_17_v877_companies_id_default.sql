-- BF_SERVER_v877_COMPANIES_ID_DEFAULT
-- companies.id has no default on the live database (contacts.id does), so any insert that leaves id out -
-- adding a company in the CRM, the public API's create-company - fails with 23502. Give it the same default.
-- Setting a default is idempotent: re-running this is a no-op.
ALTER TABLE companies ALTER COLUMN id SET DEFAULT gen_random_uuid();
