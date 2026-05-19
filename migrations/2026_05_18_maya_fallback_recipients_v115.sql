-- Block 115 — index used by /api/communications/maya-handoff
-- to query staff_presence joined to users by phone. Idempotent.
CREATE INDEX IF NOT EXISTS idx_staff_presence_status_available
  ON staff_presence(status)
  WHERE status = 'available';
