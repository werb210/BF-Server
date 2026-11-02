-- BF_SERVER_v870_CRM_DATA_MODEL - batch 3 of the BF vs Keystone audit: custom fields, teams and record visibility,
-- extra pipelines, custom roles. Ported from KS migrations 2026_11_03_ks_v20_crm_fields_teams_webhooks.sql (without
-- the outgoing-webhook part), 2026_11_04_ks_hg1_pipelines.sql and 2026_11_05_ks_custom_roles.sql. Keystone's plan
-- limits are not carried over. Idempotent: safe to run on every start.
--
-- Nothing changes for anyone on day 1:
--   - every person keeps users.record_visibility NULL and every built-in role is seeded with "all", so Todd, Andrew,
--     Caden and all other staff keep seeing every record;
--   - every person keeps users.custom_role_id NULL, which means exactly the access their built-in role gives today;
--   - no application has a pipeline_id, so every file stays on the lending board with its stage;
--   - there are no custom fields until an Admin adds one.

-- 1. Custom fields (Settings > Properties) ---------------------------------------------------------------------------
-- Definitions belong to one silo (BF, BI, SLF). Values live on the record, in its custom_fields jsonb column, keyed
-- by the field's internal name. Definitions are archived, never deleted.
CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  object_type text NOT NULL,
  name text NOT NULL,
  label text NOT NULL,
  field_type text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  required boolean NOT NULL DEFAULT false,
  group_name text,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_field_definitions_silo_check CHECK (silo IN ('BF', 'BI', 'SLF')),
  CONSTRAINT custom_field_definitions_object_check CHECK (object_type IN ('contact', 'company', 'application')),
  CONSTRAINT custom_field_definitions_type_check CHECK (field_type IN
    ('text', 'long_text', 'number', 'money', 'date', 'single_select', 'multi_select', 'checkbox', 'url', 'email', 'phone')),
  CONSTRAINT custom_field_definitions_name_check CHECK (name ~ '^[a-z][a-z0-9_]{0,62}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_field_definitions_name_uq ON custom_field_definitions (silo, object_type, name);
CREATE INDEX IF NOT EXISTS custom_field_definitions_order_idx ON custom_field_definitions (silo, object_type, sort_order, created_at);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS contacts_custom_fields_gin ON contacts USING gin (custom_fields jsonb_path_ops);
CREATE INDEX IF NOT EXISTS companies_custom_fields_gin ON companies USING gin (custom_fields jsonb_path_ops);
CREATE INDEX IF NOT EXISTS applications_custom_fields_gin ON applications USING gin (custom_fields jsonb_path_ops);

-- 2. Teams and record visibility (Settings > Teams) ------------------------------------------------------------------
-- sales_teams / sales_team_members are named so they never collide with the team chat's team_* tables.
CREATE TABLE IF NOT EXISTS sales_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_teams_name_uq ON sales_teams (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS sales_team_members (
  team_id uuid NOT NULL REFERENCES sales_teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by uuid,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS sales_team_members_user_idx ON sales_team_members (user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_team_id uuid;
-- NULL = follow the role's setting (the default for everyone).
ALTER TABLE users ADD COLUMN IF NOT EXISTS record_visibility text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_record_visibility_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_record_visibility_check
      CHECK (record_visibility IS NULL OR record_visibility IN ('all', 'team', 'own'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS role_record_visibility (
  role text PRIMARY KEY,
  visibility text NOT NULL DEFAULT 'all',
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_record_visibility_check CHECK (visibility IN ('all', 'team', 'own'))
);
-- Existing staff default to "All". ON CONFLICT DO NOTHING keeps whatever an Admin chose later.
INSERT INTO role_record_visibility (role, visibility) VALUES ('Staff', 'all'), ('Ops', 'all'), ('Marketing', 'all')
ON CONFLICT (role) DO NOTHING;

-- 3. Extra pipelines (Settings > Pipelines) --------------------------------------------------------------------------
-- The lending pipeline is not a row here: it keeps applications.pipeline_state, its locked system stages and every
-- existing behaviour. An application in an extra pipeline has pipeline_id / pipeline_stage_id set and leaves the
-- lending board (its pipeline_state is kept, so moving it back puts it where it was).
CREATE TABLE IF NOT EXISTS pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipelines_silo_check CHECK (silo IN ('BF', 'BI', 'SLF'))
);
CREATE UNIQUE INDEX IF NOT EXISTS pipelines_name_uidx ON pipelines (silo, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipelines(id),
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  color text NOT NULL DEFAULT '#1d4ed8',
  probability integer NOT NULL DEFAULT 0,
  outcome text NOT NULL DEFAULT 'open',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_stages_probability_check CHECK (probability BETWEEN 0 AND 100),
  CONSTRAINT pipeline_stages_outcome_check CHECK (outcome IN ('open', 'won', 'lost'))
);
CREATE INDEX IF NOT EXISTS pipeline_stages_pipeline_idx ON pipeline_stages (pipeline_id, position);

ALTER TABLE applications ADD COLUMN IF NOT EXISTS pipeline_id uuid;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS pipeline_stage_id uuid;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS pipeline_stage_entered_at timestamptz;
CREATE INDEX IF NOT EXISTS applications_pipeline_idx ON applications (pipeline_id, pipeline_stage_id) WHERE pipeline_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pipeline_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  from_pipeline_id uuid,
  from_stage text,
  to_pipeline_id uuid,
  to_stage text,
  moved_by uuid,
  moved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_moves_application_idx ON pipeline_moves (application_id, moved_at DESC);

-- 4. Custom roles (Settings > Users & roles) -------------------------------------------------------------------------
-- A custom role starts from a built-in role (base_role) and can only take permissions away from it. People keep
-- users.role = the base role, so every existing role check treats them as before; users.custom_role_id adds the
-- matrix on top (src/roles/enforce.ts). Nobody gets a custom role from this migration.
CREATE TABLE IF NOT EXISTS custom_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  base_role text NOT NULL DEFAULT 'Staff',
  -- { "contacts": { "view": true, "create": true, ... }, ... } (src/roles/permissions.ts)
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  record_visibility text NOT NULL DEFAULT 'all',
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT custom_roles_base_role_check CHECK (base_role IN ('Admin', 'Ops', 'Staff', 'Marketing')),
  CONSTRAINT custom_roles_record_visibility_check CHECK (record_visibility IN ('all', 'team', 'own'))
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_roles_name_uidx ON custom_roles (lower(name)) WHERE archived_at IS NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_role_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_custom_role_id_fkey') THEN
    ALTER TABLE users ADD CONSTRAINT users_custom_role_id_fkey
      FOREIGN KEY (custom_role_id) REFERENCES custom_roles(id) ON DELETE SET NULL;
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS users_custom_role_idx ON users (custom_role_id) WHERE custom_role_id IS NOT NULL;
