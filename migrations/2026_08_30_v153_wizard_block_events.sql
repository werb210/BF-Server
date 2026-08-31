-- BF_SERVER_WIZARD_BLOCK_v153
-- Step 1 answers live in localStorage until startApplication() runs, and the
-- Canadian revenue hard stop returns before that. So the selection that stopped
-- someone never reached the server: the abandoned list shows twenty rows sitting
-- at "Step 1 - Financial profile" with no way to tell a hard stop from someone
-- who just wandered off.
--
-- One row per block. application_id and contact_id are nullable on purpose: a
-- visitor who lands straight on the wizard has neither yet, and the count still
-- answers "how many are we turning away and why" even when we cannot say who.
CREATE TABLE IF NOT EXISTS wizard_block_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reason          TEXT NOT NULL,
  step            INTEGER NOT NULL DEFAULT 1,
  country         TEXT,
  monthly_revenue TEXT,
  application_id  TEXT,
  contact_id      TEXT,
  lead_id         TEXT,
  phone           TEXT,
  session_key     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wbe_created ON wizard_block_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wbe_app     ON wizard_block_events (application_id);

-- One row per session per reason. The select fires on every change of the
-- dropdown, so a user toggling between options would otherwise write a row each
-- time and inflate the count.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wbe_session_reason
  ON wizard_block_events (COALESCE(session_key, id::text), reason);
