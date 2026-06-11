-- BF_SERVER_BLOCK_v819_IMPORT_FROM_BI_VIA_API
-- (1) notifications.id has no default on the live DB, so inserts that omit id
-- (emailFollowupWorker) fail with 23502 — which ALSO skips the
-- "followup_notified_at = now()" update, so the same email re-notifies every
-- tick and cleared notifications repopulate. Add the default.
ALTER TABLE notifications ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- (2) Drain rows currently stuck in the loop: unopened, never successfully
-- notified, older than 24h. Mark them notified so they stop regenerating the
-- moment this deploys (the next successful insert would notify once anyway,
-- but this stops the repopulation immediately).
UPDATE crm_email_log
   SET followup_notified_at = now()
 WHERE opened_at IS NULL
   AND followup_notified_at IS NULL
   AND created_at < now() - interval '24 hours';
