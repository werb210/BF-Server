-- BF_SERVER_SEND_HOLD_WINDOW_v1 - a cancellable hold window before a queued
-- blast actually sends. The worker ignores jobs whose not_before is in the
-- future; staff can cancel during the hold so nothing goes out. NULL keeps all
-- pre-existing jobs sending immediately (backward compatible).
ALTER TABLE marketing_send_jobs ADD COLUMN IF NOT EXISTS not_before timestamptz;
