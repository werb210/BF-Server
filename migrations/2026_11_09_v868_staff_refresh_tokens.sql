-- BF_SERVER_v868_SLIDING_REFRESH - rotating staff refresh tokens (src/auth/staffRefresh.ts), ported from KS-server #45.
-- One row per issued token; every token from one sign-in shares a family_id and that sign-in's session_started_at
-- (30-day hard limit). Only the SHA-256 of a token is stored. The older auth_refresh_tokens table has no family,
-- rotation or session columns, so it is left as it is ("sign out everywhere" still clears both).
-- No silo column: these are sign-in records, not CRM data; the token minted from one takes the user's silos.
-- ksid is null in Boreal until device sessions exist. Safe to run again.
CREATE TABLE IF NOT EXISTS staff_refresh_tokens (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL,
  user_id uuid NOT NULL,
  ksid text,
  token_version integer NOT NULL DEFAULT 0,
  token_hash text NOT NULL,
  session_started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_refresh_tokens_hash_uq ON staff_refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS staff_refresh_tokens_family_idx ON staff_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS staff_refresh_tokens_user_idx ON staff_refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS staff_refresh_tokens_expires_idx ON staff_refresh_tokens (expires_at);
