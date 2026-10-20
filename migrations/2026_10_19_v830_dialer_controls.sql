-- BF_SERVER_v830_DIALER_CONTROLS - a call that had someone added (add participant / transfer): legs stay when one
-- leaves, and the call is ended once one person is left (voice/multiParty.ts).
ALTER TABLE conferences ADD COLUMN IF NOT EXISTS multi_party boolean NOT NULL DEFAULT false;
