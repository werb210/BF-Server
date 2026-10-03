-- BF_SERVER_REPORTS_SECTION_v714
-- Drag-and-drop Reports: each person's tabs and Dashboard, plus team tabs that
-- Admins publish for everyone. cards = [{ id, report, size, days }].
CREATE TABLE IF NOT EXISTS report_layouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id text,
  kind text NOT NULL,
  silo text NOT NULL DEFAULT 'BF',
  name text NOT NULL DEFAULT '',
  position int NOT NULL DEFAULT 0,
  team boolean NOT NULL DEFAULT false,
  cards jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_layouts_owner_idx ON report_layouts (owner_user_id, silo, kind);
CREATE INDEX IF NOT EXISTS report_layouts_team_idx ON report_layouts (team, silo) WHERE team;
