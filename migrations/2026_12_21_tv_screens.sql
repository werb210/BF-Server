-- BF_SERVER_TV_SCOREBOARD_v1 - office TVs showing the sales scoreboard (the Apple TV app). A TV pairs through KS-Ops with
-- a code; this server keeps one row per paired TV with the hash of its read-only screen token, which teams it shows (null =
-- everyone), which screens it rotates through and how fast. Removing a TV sets removed_at; its token stops working at once.
CREATE TABLE IF NOT EXISTS tv_screens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  team_ids uuid[],
  slides text[] NOT NULL DEFAULT ARRAY['leaderboard', 'teams', 'goal', 'recent']::text[],
  rotate_seconds integer NOT NULL DEFAULT 20,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  removed_at timestamptz
);
CREATE INDEX IF NOT EXISTS tv_screens_live_idx ON tv_screens (removed_at);
