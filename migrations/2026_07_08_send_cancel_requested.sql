-- BF_SERVER_SEND_KILL_SWITCH_v1 - a cancel-requested flag so a blast can be
-- stopped mid-send (not just during the hold). The send runner checks this flag
-- between recipients and aborts; the worker then marks the job canceled.
ALTER TABLE marketing_send_jobs ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
