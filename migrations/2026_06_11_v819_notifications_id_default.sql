-- BF_SERVER_BLOCK_v819_IMPORT_FROM_BI_VIA_API
-- notifications.id on the live DB has no default, so inserts that omit id
-- (emailFollowupWorker) fail with 23502. Add the default idempotently.
ALTER TABLE notifications ALTER COLUMN id SET DEFAULT gen_random_uuid();
