-- BF_SERVER_PRESENCE_AUTO_BUSY_v1
-- Reason flags so manual / on-call / in-meeting busy states don't clobber each
-- other. `status` is recomputed from these + heartbeat + the 8-18 MST window.
ALTER TABLE IF EXISTS staff_presence
  ADD COLUMN IF NOT EXISTS manual_busy boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS on_call     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS in_meeting  boolean NOT NULL DEFAULT false;
